import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import {
	AI_HERO_COURSE_SYNC_BINDING,
	type CourseSyncBinding,
	type ResourcePlanItem,
	type SyncPlan,
} from './types'
import {
	summarizeCourseSyncPlanChanges,
	assertManagedChildRelations,
	chunkCourseSyncWrites,
	courseSyncRollbackPointer,
	evaluateCourseSyncBoundedAutoApply,
	resolveCourseSyncRollbackFields,
} from './persistence-invariants'

function launchPlan(): SyncPlan {
	let position = 0
	const resources: ResourcePlanItem[] = []
	for (const [sourceKind, updateCount, retainCount] of [
		['section', 0, 6],
		['lesson', 21, 38],
		['solution', 11, 0],
		['video', 18, 52],
		['question', 0, 87],
	] as const) {
		for (const [action, count] of [
			['update', updateCount],
			['retain', retainCount],
		] as const) {
			for (let index = 0; index < count; index += 1) {
				const sourceId = `${sourceKind}-${action}-${index}`
				resources.push({
					sourceKind,
					sourceId,
					targetResourceId: `target-${sourceId}`,
					parentResourceId: `parent-${sourceKind}`,
					position: position++,
					detached: false,
					previousDetached: false,
					previousParentResourceId: `parent-${sourceKind}`,
					previousPosition: position - 1,
					action,
					fields: { sourceId },
					previousVersionId: `version-${sourceId}`,
					previousFieldsSha256: 'a'.repeat(64),
				})
			}
		}
	}
	return {
		bindingId: AI_HERO_COURSE_SYNC_BINDING.bindingId,
		sourceRevisionId: 'revision-launch',
		courseVersionId: 'course-version-launch',
		resources,
		media: Array.from({ length: 70 }, (_, index) => ({
			sourceVideoId: `video-${index}`,
			providerRevision: `revision-${index}`,
			sha256: `${index}`.padStart(64, '0'),
			bytes: index + 1,
			action: index < 18 ? ('update' as const) : ('retain' as const),
			muxAssetId: `mux-${index}`,
			muxPlaybackId: `playback-${index}`,
			duration: 60,
		})),
		planSha256: 'b'.repeat(64),
	}
}

function currentManifestPlan(): SyncPlan {
	const plan = launchPlan()
	for (const resource of plan.resources) resource.action = 'retain'
	for (const resource of plan.resources
		.filter((resource) => resource.sourceKind === 'lesson')
		.slice(0, 2)) {
		resource.action = 'update'
	}
	plan.resources.find((resource) => resource.sourceKind === 'video')!.action =
		'update'
	for (const media of plan.media) media.action = 'retain'
	plan.media[0]!.action = 'update'
	return plan
}

function section(position: number) {
	return {
		position,
		resource: {
			type: 'section',
			fields: {
				state: 'draft',
				visibility: 'unlisted',
				courseSync: { bindingId: AI_HERO_COURSE_SYNC_BINDING.bindingId },
			},
		},
	}
}

describe('course sync persistence invariants', () => {
	it('creates the exact prefixed frozen-asset receipt table without masking drift', () => {
		const migration = readFileSync(
			new URL(
				'../db/migrations/20260816_ai_hero_course_sync_launch_safety.sql',
				import.meta.url,
			),
			'utf8',
		)
		expect(migration).toMatch(
			/^CREATE TABLE `AI_CourseSyncFrozenAssetReceipt` \(/,
		)
		expect(migration).not.toMatch(/IF NOT EXISTS/i)
		expect(migration).not.toMatch(/CREATE TABLE `CourseSyncFrozenAssetReceipt`/)
	})

	it('adds one nullable durable operator-policy override to poll state', () => {
		const migration = readFileSync(
			new URL(
				'../db/migrations/20260821_ai_hero_course_sync_review_gate.sql',
				import.meta.url,
			),
			'utf8',
		)
		expect(migration).toBe(
			'ALTER TABLE `AI_CourseSyncPollState`\n  ADD COLUMN `applyPolicyOverride` varchar(32) DEFAULT NULL;\n',
		)
		expect(migration).not.toMatch(/IF NOT EXISTS/i)
	})

	it('treats the source manifest as authoritative for every plan shape', () => {
		expect(evaluateCourseSyncBoundedAutoApply(launchPlan())).toEqual({
			eligible: true,
			planSha256: 'b'.repeat(64),
		})
		expect(evaluateCourseSyncBoundedAutoApply(currentManifestPlan())).toEqual({
			eligible: true,
			planSha256: 'b'.repeat(64),
		})
	})

	it.each([
		[
			'reparent',
			(plan: SyncPlan) => {
				plan.resources[0]!.parentResourceId = 'another-parent'
			},
		],
		[
			'reorder',
			(plan: SyncPlan) => {
				plan.resources[0]!.position += 1
			},
		],
		[
			'detach',
			(plan: SyncPlan) => {
				plan.resources[0]!.detached = true
			},
		],
		[
			'create',
			(plan: SyncPlan) => {
				plan.resources[0]!.action = 'create'
				plan.resources[0]!.previousParentResourceId = null
				plan.resources[0]!.previousPosition = null
				plan.resources[0]!.previousVersionId = null
				plan.resources[0]!.previousFieldsSha256 = null
			},
		],
		[
			'added resources beyond the launch inventory',
			(plan: SyncPlan) => {
				plan.resources = [
					...plan.resources,
					{ ...plan.resources[0]!, action: 'create' },
				]
			},
		],
		[
			'every resource updated at once',
			(plan: SyncPlan) => {
				for (const resource of plan.resources) resource.action = 'update'
			},
		],
	] as const)('applies %s without an operator gate', (_label, mutate) => {
		const plan = launchPlan()
		mutate(plan)
		expect(evaluateCourseSyncBoundedAutoApply(plan)).toEqual({
			eligible: true,
			planSha256: 'b'.repeat(64),
		})
	})

	it('summarizes only the changed resources for the human notice', () => {
		const plan = currentManifestPlan()
		for (const resource of plan.resources) resource.action = 'retain'
		const created = plan.resources[0]!
		created.action = 'create'
		created.fields = { title: 'More Exercises' }
		const moved = plan.resources[1]!
		moved.action = 'update'
		moved.fields = { title: 'Setting Up the Project' }
		moved.position += 3

		const changes = summarizeCourseSyncPlanChanges(plan)

		expect(changes).toHaveLength(2)
		expect(changes[0]).toMatchObject({
			action: 'create',
			title: 'More Exercises',
			detached: false,
		})
		expect(changes[1]).toMatchObject({
			action: 'update',
			title: 'Setting Up the Project',
			moved: true,
		})
	})

	it('reports a detachment only when this plan performs it', () => {
		const plan = currentManifestPlan()
		for (const resource of plan.resources) resource.action = 'retain'
		const detaching = plan.resources[0]!
		detaching.action = 'update'
		detaching.detached = true
		detaching.previousDetached = false
		const alreadyDetached = plan.resources[1]!
		alreadyDetached.action = 'update'
		alreadyDetached.detached = true
		alreadyDetached.previousDetached = true

		const changes = summarizeCourseSyncPlanChanges(plan)

		expect(changes).toHaveLength(2)
		expect(changes[0]?.detached).toBe(true)
		expect(changes[1]?.detached).toBe(false)
	})

	it('restores previous fields into both the rollback version and denormalized pointer', () => {
		const appliedFields = {
			title: 'Applied title',
			body: 'Applied body',
			state: 'draft',
			visibility: 'unlisted',
			courseSync: { bindingId: 'binding-1', active: true },
		}
		const previousFields = {
			title: 'Previous title',
			body: 'Previous body',
			state: 'draft',
			visibility: 'unlisted',
			courseSync: { bindingId: 'binding-1', active: true },
		}
		const restoredFields = resolveCourseSyncRollbackFields({
			action: 'update',
			sourceKind: 'lesson',
			currentFields: appliedFields,
			previousVersionFields: previousFields,
			runId: 'run-1',
		})
		const pointer = courseSyncRollbackPointer({
			resourceId: 'lesson-1',
			resourceType: 'lesson',
			createdById: 'user-1',
			versionId: 'version-previous',
			fields: restoredFields,
		})

		expect(restoredFields).toEqual(previousFields)
		expect(restoredFields).not.toEqual(appliedFields)
		expect(pointer).toEqual({
			id: 'lesson-1',
			type: 'lesson',
			createdById: 'user-1',
			currentVersionId: 'version-previous',
			fields: previousFields,
		})
	})

	it('rejects an updated resource when its previous version fields are missing', () => {
		expect(() =>
			resolveCourseSyncRollbackFields({
				action: 'update',
				sourceKind: 'lesson',
				currentFields: { title: 'Applied' },
				previousVersionFields: null,
				runId: 'run-1',
			}),
		).toThrowError(
			expect.objectContaining({ code: 'ROLLBACK_PARENT_VERSION_MISSING' }),
		)
	})

	it('leaves retained fields alone and safely tombstones created resource fields', () => {
		const currentFields = {
			title: 'Current',
			state: 'ready',
			visibility: 'unlisted',
			courseSync: { bindingId: 'binding-1', active: true },
		}
		expect(
			resolveCourseSyncRollbackFields({
				action: 'retain',
				sourceKind: 'video',
				currentFields,
				previousVersionFields: null,
				runId: 'run-1',
			}),
		).toEqual(currentFields)
		expect(
			resolveCourseSyncRollbackFields({
				action: 'create',
				sourceKind: 'video',
				currentFields,
				previousVersionFields: null,
				runId: 'run-1',
			}),
		).toEqual({
			...currentFields,
			state: 'deleted',
			visibility: 'unlisted',
			courseSync: {
				bindingId: 'binding-1',
				active: false,
				rollbackOfRunId: 'run-1',
			},
		})
	})

	it('splits apply writes into bounded multi-row batches without loss or duplication', () => {
		const rows = Array.from({ length: 121 }, (_, index) => index)
		const chunks = chunkCourseSyncWrites(rows, 50)
		expect(chunks.map((chunk) => chunk.length)).toEqual([50, 50, 21])
		expect(chunks.flat()).toEqual(rows)
	})

	it('accepts any number of ordered managed sections', () => {
		expect(() =>
			assertManagedChildRelations(
				AI_HERO_COURSE_SYNC_BINDING as CourseSyncBinding,
				[section(0), section(1), section(2)],
			),
		).not.toThrow()
	})

	it('rejects duplicate, negative, or foreign managed child slots', () => {
		const binding = AI_HERO_COURSE_SYNC_BINDING as CourseSyncBinding
		expect(() =>
			assertManagedChildRelations(binding, [section(0), section(0)]),
		).toThrowError(
			expect.objectContaining({ code: 'TARGET_CHILD_SCOPE_WIDENED' }),
		)
		expect(() =>
			assertManagedChildRelations(binding, [section(-1)]),
		).toThrowError(
			expect.objectContaining({ code: 'TARGET_CHILD_SCOPE_WIDENED' }),
		)
		expect(() =>
			assertManagedChildRelations(binding, [
				{
					...section(3),
					resource: {
						type: 'section',
						fields: {
							state: 'draft',
							visibility: 'unlisted',
							courseSync: { bindingId: 'another-binding' },
						},
					},
				},
			]),
		).toThrowError(
			expect.objectContaining({ code: 'TARGET_CHILD_SCOPE_WIDENED' }),
		)
	})
})
