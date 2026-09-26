import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { sha256, stableJson } from './control-plane'

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
	courseSyncAnchorTreeParentIds,
	courseSyncRollbackPointer,
	evaluateCourseSyncBoundedAutoApply,
	resolveCourseSyncRollbackFields,
	verifyCourseSyncActivation,
	verifyCourseSyncRelations,
} from './persistence-invariants'

function sealPlan(plan: SyncPlan): SyncPlan {
	const { planSha256: _claimed, ...input } = plan
	plan.planSha256 = sha256(stableJson(input))
	return plan
}

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
	return sealPlan({
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
		planSha256: '',
	})
}

function activationFixture(detached = false) {
	const item: ResourcePlanItem = {
		...launchPlan().resources[0]!,
		fields: { title: 'Activation fixture' },
		detached,
	}
	const plan: SyncPlan = sealPlan({ ...launchPlan(), resources: [item], media: [] })
	const receipt = { resourceId: item.targetResourceId, contentResourceVersionId: 'version-after-apply' }
	const resource = { id: item.targetResourceId, currentVersionId: receipt.contentResourceVersionId, fields: item.fields }
	const deletedAt = detached ? new Date('2026-09-26T00:00:00.123Z') : null
	const relation = { resourceId: item.targetResourceId, resourceOfId: item.parentResourceId,
		position: item.position, deletedAt }
	const expectedDeletedAtByResource = new Map<string, Date>()
	if (deletedAt) expectedDeletedAtByResource.set(item.targetResourceId, deletedAt)
	return { plan, receipts: [receipt], resources: [resource], relations: [relation], expectedDeletedAtByResource }
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
	return sealPlan(plan)
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
	it('verifies activation with a detached item having one current dead relation and no live one', () => {
		const fixture = activationFixture(true)
		expect(verifyCourseSyncActivation(fixture.plan, fixture.receipts, fixture.resources, fixture.relations, fixture.expectedDeletedAtByResource)).toEqual({ ok: true })
	})

	it('rejects activation when a detached item has no dead relation', () => {
		const fixture = activationFixture(true)
		expect(verifyCourseSyncActivation(fixture.plan, fixture.receipts, fixture.resources, [], fixture.expectedDeletedAtByResource)).toMatchObject({
			ok: false, resourceId: fixture.plan.resources[0]!.targetResourceId,
		})
	})

	it('rejects a stale tombstone from an earlier apply', () => {
		const fixture = activationFixture(true)
		fixture.relations[0]!.deletedAt = new Date('2026-09-25T00:00:00.123Z')
		expect(verifyCourseSyncActivation(fixture.plan, fixture.receipts, fixture.resources, fixture.relations, fixture.expectedDeletedAtByResource)).toMatchObject({
			ok: false, resourceId: fixture.plan.resources[0]!.targetResourceId,
		})
	})

	it('rejects multiple dead rows at the planned parent and position', () => {
		const fixture = activationFixture(true)
		const rows = [fixture.relations[0]!, { ...fixture.relations[0]! }]
		expect(verifyCourseSyncActivation(fixture.plan, fixture.receipts, fixture.resources, rows, fixture.expectedDeletedAtByResource)).toMatchObject({
			ok: false, resourceId: fixture.plan.resources[0]!.targetResourceId,
		})
	})

	it('rejects activation when a detached item still has a live relation', () => {
		const fixture = activationFixture(true)
		fixture.relations[0]!.deletedAt = null
		expect(verifyCourseSyncActivation(fixture.plan, fixture.receipts, fixture.resources, fixture.relations, fixture.expectedDeletedAtByResource)).toMatchObject({
			ok: false, resourceId: fixture.plan.resources[0]!.targetResourceId,
		})
	})

	it('rejects activation when an attached item has zero or two live relations', () => {
		const fixture = activationFixture()
		for (const relations of [[], [fixture.relations[0]!, { ...fixture.relations[0]! }]]) {
			expect(verifyCourseSyncActivation(fixture.plan, fixture.receipts, fixture.resources, relations, fixture.expectedDeletedAtByResource)).toMatchObject({
				ok: false, resourceId: fixture.plan.resources[0]!.targetResourceId,
			})
		}
	})

	it('rejects activation when a pointer or fields drift from the plan', () => {
		const fixture = activationFixture()
		for (const resources of [
			[{ ...fixture.resources[0]!, currentVersionId: 'other-version' }],
			[{ ...fixture.resources[0]!, fields: { title: 'Other title' } }],
		]) {
			expect(verifyCourseSyncActivation(fixture.plan, fixture.receipts, resources, fixture.relations, fixture.expectedDeletedAtByResource)).toMatchObject({
				ok: false, resourceId: fixture.plan.resources[0]!.targetResourceId,
			})
		}
	})
	it('verifies rollback tombstones and restored live relations together', () => {
		const now = new Date('2026-09-26T01:00:00.123Z')
		const expected = [
			{ resourceId: 'detached', parentResourceId: 'parent-a', position: 1, detached: true },
			{ resourceId: 'restored', parentResourceId: 'parent-b', position: 2, detached: false },
		]
		const rows = [
			{ resourceId: 'detached', resourceOfId: 'parent-a', position: 1, deletedAt: now },
			{ resourceId: 'restored', resourceOfId: 'parent-b', position: 2, deletedAt: null },
		]
		const marker = new Map([['detached', now], ['restored', now]])
		const scope = { bindingId: 'binding-a', anchorTreeParentIds: new Set(['parent-a', 'parent-b']) }
		expect(verifyCourseSyncRelations(expected, rows, marker, scope)).toEqual({ ok: true })
		expect(verifyCourseSyncRelations(expected, rows.slice(1), marker, scope))
			.toMatchObject({ ok: false, resourceId: 'detached' })
		expect(verifyCourseSyncRelations(expected, [...rows,
			{ resourceId: 'restored', resourceOfId: 'parent-a', position: 0, deletedAt: now },
		], marker, scope)).toMatchObject({ ok: false, resourceId: 'restored' })
		expect(verifyCourseSyncRelations(expected, [
			{ ...rows[0]!, deletedAt: new Date('2020-01-01') }, rows[1]!,
		], marker, scope)).toMatchObject({ ok: false, resourceId: 'detached' })
		expect(verifyCourseSyncRelations(expected, [...rows, { ...rows[1]! }], marker, scope))
			.toMatchObject({ ok: false, resourceId: 'restored' })
	})

	it('derives the known anchor tree without treating unrelated parents as managed', () => {
		const plan = launchPlan()
		plan.resources[0]!.previousParentResourceId = 'prior-plan-parent'
		const parents = courseSyncAnchorTreeParentIds('anchor-workshop', plan)
		for (const parent of ['anchor-workshop', 'prior-plan-parent',
			plan.resources[0]!.targetResourceId, plan.resources[0]!.parentResourceId]) {
			expect(parents.has(parent)).toBe(true)
		}
		expect(parents.has('hand-curated')).toBe(false)
	})

	it('rejects stray managed rollback relations but ignores unmanaged ones', () => {
		const now = new Date('2026-09-26T01:00:00.123Z')
		const expected = [
			{ resourceId: 'moved', parentResourceId: 'old-managed', position: 1, detached: false },
			{ resourceId: 'moved', parentResourceId: 'new-managed', position: 2, detached: true },
		]
		const rows = [
			{ resourceId: 'moved', resourceOfId: 'old-managed', position: 1, deletedAt: null },
			{ resourceId: 'moved', resourceOfId: 'new-managed', position: 2, deletedAt: now },
		]
		const marker = new Map([['moved', now]])
		const scope = { bindingId: 'binding-a', anchorTreeParentIds: new Set(['old-managed', 'new-managed']) }
		// A→B→C→B: the tagged A tombstone predates this rollback and is history.
		expect(verifyCourseSyncRelations(expected, [...rows,
			{ resourceId: 'moved', resourceOfId: 'retired-managed', position: 0,
				deletedAt: new Date('2020-01-01'), metadata: { bindingId: 'binding-a' } },
		], marker, scope)).toEqual({ ok: true })
		expect(verifyCourseSyncRelations(expected, [...rows,
			{ resourceId: 'moved', resourceOfId: 'retired-managed', position: 0,
				deletedAt: null, metadata: { bindingId: 'binding-a' } },
		], marker, scope)).toMatchObject({ ok: false, resourceId: 'moved' })
		expect(verifyCourseSyncRelations(expected, [...rows,
			{ resourceId: 'moved', resourceOfId: 'retired-managed', position: 0,
				deletedAt: now, metadata: { bindingId: 'binding-a' } },
		], marker, scope)).toMatchObject({ ok: false, resourceId: 'moved' })
		expect(verifyCourseSyncRelations(expected, [...rows,
			{ resourceId: 'moved', resourceOfId: 'hand-curated', position: 0, deletedAt: null },
		], marker, scope)).toEqual({ ok: true })
	})

	it('rejects a tagged retired-section live edge on rollback, outside the current plan', () => {
		const now = new Date('2026-09-26T01:00:00.123Z')
		const expected = [{ resourceId: 'lesson', parentResourceId: 'current-section', position: 0, detached: false }]
		const rows = [
			{ resourceId: 'lesson', resourceOfId: 'current-section', position: 0, deletedAt: null,
				metadata: { bindingId: 'binding-a' } },
			{ resourceId: 'lesson', resourceOfId: 'retired-section', position: 1, deletedAt: null,
				metadata: { bindingId: 'binding-a' } },
		]
		// Only the current section appears in the plan. The retired section must still count.
		const currentParents = new Set(['anchor', 'current-section'])
		expect(verifyCourseSyncRelations(expected, rows, new Map([['lesson', now]]),
			{ bindingId: 'binding-a', anchorTreeParentIds: currentParents }))
			.toMatchObject({ ok: false, resourceId: 'lesson' })
	})

	it('rejects a tagged retired-section live edge on apply but ignores an untagged list', () => {
		const fixture = activationFixture()
		const id = fixture.plan.resources[0]!.targetResourceId
		const currentParents = new Set([fixture.relations[0]!.resourceOfId])
		const extra = { resourceId: id, resourceOfId: 'retired-section', position: 2,
			deletedAt: null, metadata: { bindingId: fixture.plan.bindingId } }
		expect(verifyCourseSyncActivation(fixture.plan, fixture.receipts, fixture.resources,
			[...fixture.relations, extra], fixture.expectedDeletedAtByResource,
			{ bindingId: fixture.plan.bindingId, anchorTreeParentIds: currentParents }))
			.toMatchObject({ ok: false, resourceId: id })
		expect(verifyCourseSyncActivation(fixture.plan, fixture.receipts, fixture.resources,
			[...fixture.relations, { ...extra, metadata: null }],
			fixture.expectedDeletedAtByResource,
			{ bindingId: fixture.plan.bindingId, anchorTreeParentIds: currentParents })).toEqual({ ok: true })
	})

	it.each([false, true])('applies detached=%s with an unmanaged relation but rejects another managed live relation', (detached) => {
		const fixture = activationFixture(detached)
		const extra = { ...fixture.relations[0]!, resourceOfId: 'hand-curated', deletedAt: null }
		const scope = { bindingId: fixture.plan.bindingId,
			anchorTreeParentIds: new Set([fixture.relations[0]!.resourceOfId, 'other-managed']) }
		expect(verifyCourseSyncActivation(fixture.plan, fixture.receipts, fixture.resources,
			[...fixture.relations, extra], fixture.expectedDeletedAtByResource, scope)).toEqual({ ok: true })
		expect(verifyCourseSyncActivation(fixture.plan, fixture.receipts, fixture.resources,
			[...fixture.relations, { ...extra, resourceOfId: 'other-managed' }],
			fixture.expectedDeletedAtByResource, scope)).toMatchObject({ ok: false, resourceId: fixture.plan.resources[0]!.targetResourceId })
	})

	it('reads detached relations for apply verification rather than filtering dead rows', () => {
		const applySource = readFileSync(new URL('./drizzle-persistence.ts', import.meta.url), 'utf8')
		const readback = applySource.split('const activatedRelations = await trx')[1]?.split('const appliedAt = new Date()')[0]
		expect(readback).toContain('deletedAt: contentResourceResource.deletedAt')
		expect(readback).toContain('metadata: contentResourceResource.metadata')
		expect(readback).not.toContain('isNull(contentResourceResource.deletedAt)')
		const rollbackReadback = applySource.split('const restoredRelations = await trx')[1]
			?.split('const verification = verifyCourseSyncRelations')[0]
		expect(rollbackReadback).toContain('metadata: contentResourceResource.metadata')
	})

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
		for (const plan of [launchPlan(), currentManifestPlan()]) {
			expect(evaluateCourseSyncBoundedAutoApply(plan)).toEqual({
				eligible: true,
				planSha256: plan.planSha256,
			})
		}
	})

	it('routes lesson regressions to operator review without marking the plan failed', () => {
		const plan = sealPlan({ ...launchPlan(), lessonRegressions: ['lesson-1'] })
		expect(evaluateCourseSyncBoundedAutoApply(plan)).toEqual({
			eligible: false,
			planSha256: plan.planSha256,
			reason: 'Lesson regressions require operator review: lesson-1',
			failureCode: 'LESSON_REGRESSION_REVIEW_REQUIRED',
		})
	})

	it('requires review of a legacy placeholder update without a regression field', () => {
		const plan = launchPlan()
		const lesson = plan.resources.find((item) => item.sourceKind === 'lesson')!
		lesson.fields = { courseSync: { lessonType: 'placeholder' } }
		sealPlan(plan)
		expect(evaluateCourseSyncBoundedAutoApply(plan)).toMatchObject({
			eligible: false,
			failureCode: 'LEGACY_PLACEHOLDER_PREVIEW_REVIEW_REQUIRED',
		})
	})

	it('allows a tracked placeholder update with an empty regression list', () => {
		const plan = { ...launchPlan(), lessonRegressions: [] }
		const lesson = plan.resources.find((item) => item.sourceKind === 'lesson')!
		lesson.fields = { courseSync: { lessonType: 'placeholder' } }
		sealPlan(plan)
		expect(evaluateCourseSyncBoundedAutoApply(plan)).toMatchObject({
			eligible: true,
			planSha256: plan.planSha256,
		})
	})

	it('requires review when an untracked plan detaches a video or solution', () => {
		for (const kind of ['video', 'solution'] as const) {
			const plan = launchPlan()
			const child = plan.resources.find((item) => item.sourceKind === kind)!
			child.detached = true
			sealPlan(plan)
			expect(evaluateCourseSyncBoundedAutoApply(plan)).toMatchObject({
				eligible: false,
				failureCode: 'LOST_VIDEO_REVIEW_REQUIRED',
			})
		}
	})

	it('keeps a clean plan without regression tracking eligible', () => {
		const plan = launchPlan()
		expect(plan).not.toHaveProperty('lessonRegressions')
		expect(evaluateCourseSyncBoundedAutoApply(plan)).toEqual({
			eligible: true,
			planSha256: plan.planSha256,
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
		sealPlan(plan)
		expect(evaluateCourseSyncBoundedAutoApply(plan)).toEqual({
			eligible: true,
			planSha256: plan.planSha256,
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
