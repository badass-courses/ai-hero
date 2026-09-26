import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { CourseJsonDocumentV3 } from '@ai-hero/course-sync-schema'

import { createCourseSyncControlPlane } from './control-plane'
import { InMemoryCourseSyncPersistence } from './in-memory-persistence'
import {
	assertCourseSyncTargetContract,
	type CourseSyncTargetFacts,
} from './target-contract'
import { syntheticCohortBinding as binding } from './test-fixtures/cohort-binding'
import { WorkshopSchema } from '@/lib/workshops'

function syllabus(version: string): CourseJsonDocumentV3 {
	// Synthetic shape only: 15 sections, 112 placeholders, eight ARCHIVE labels.
	return {
		$schema: 'course.schema.json',
		schemaVersion: 4,
		courseId: binding.sourceCourseId,
		courseVersionId: version,
		archiveTTL: '90d',
		courseName: 'Synthetic Cohort Syllabus',
		sections: Array.from({ length: 15 }, (_, index) => ({
			id: `section-${index}`,
			title: index === 5 || index >= 8 ? `ARCHIVE ${index}` : `Keep ${index}`,
			lessons: Array.from({ length: index < 7 ? 8 : 7 }, (_, lessonIndex) => ({
				type: 'placeholder' as const,
				id: `lesson-${index}-${lessonIndex}`,
				title: `Placeholder ${index}.${lessonIndex}`,
			})),
		})),
	}
}

function harness() {
	const persistence = new InMemoryCourseSyncPersistence()
	let sequence = 0
	const unexpected = async (): Promise<never> => {
		throw new Error('media dependency called for a placeholder syllabus')
	}
	const plane = createCourseSyncControlPlane({
		bindingRegistry: { [binding.bindingId]: binding },
		persistence,
		muxSourceResolver: { resolve: unexpected },
		muxClient: {
			getAsset: unexpected,
			createAsset: unexpected,
			waitForReady: unexpected,
		},
		createdById: 'test-writer',
		makeId: (prefix) => `${prefix}_${++sequence}`,
		clock: () => new Date('2026-09-26T00:00:00.000Z'),
	})
	const stage = async (manifest: CourseJsonDocumentV3, key: string) => {
		const run = await plane.stage({
			bindingId: binding.bindingId,
			idempotencyKey: key,
			manifest,
		})
		const preview = await plane.preview(run.runId)
		const plan = persistence.runs.get(run.runId)?.plan
		if (!plan) throw new Error('missing preview plan')
		return { run, preview, plan }
	}
	const apply = async (runId: string, key: string) => {
		const plan = persistence.runs.get(runId)?.plan
		if (!plan) throw new Error('missing apply plan')
		return persistence.applyAtomically({
			runId,
			plan,
			idempotencyKey: key,
			createdById: 'test-writer',
		})
	}
	const targetFacts = (): CourseSyncTargetFacts => ({
		product: {
			id: binding.productId,
			type: 'cohort',
			fields: { state: 'draft', visibility: 'unlisted' },
		},
		workshop: {
			id: binding.anchorCohortId,
			type: 'cohort',
			fields: { state: 'draft', visibility: 'unlisted' },
			deletedAt: null,
		},
		relation: { position: 0 },
		otherProductRelations: [],
		childRelations: [...persistence.relations.values()]
			.filter(
				(relation) =>
					relation.parentId === binding.anchorCohortId && !relation.detached,
			)
			.map((relation) => ({
				position: relation.position,
				resource: {
					id: relation.childId,
					type: persistence.resources.get(relation.childId)!.type,
					fields: persistence.resources.get(relation.childId)!.fields,
				},
			})),
	})
	// The in-memory adapter's default target check is a boolean stub. Drive its
	// real contract assertion on every stage/preview, including the next tick.
	persistence.assertTarget = async (actualBinding) => {
		assertCourseSyncTargetContract(actualBinding, targetFacts())
	}
	return { persistence, plane, stage, apply, targetFacts }
}

describe('synthetic cohort-anchored syllabus (S4b)', () => {
	it('plans and applies 15 workshop children and 112 direct lessons, without day drip or media (T8/T9)', async () => {
		const test = harness()
		const manifest = syllabus('syllabus-before')
		const first = await test.stage(manifest, 'first')
		const workshops = first.plan.resources.filter(
			(item) => item.sourceKind === 'workshop',
		)
		const lessons = first.plan.resources.filter(
			(item) => item.sourceKind === 'lesson',
		)
		expect(first.preview.resourceCounts).toMatchObject({ create: 127 })
		expect(workshops.map((item) => item.position)).toEqual(
			Array.from({ length: 15 }, (_, i) => i),
		)
		expect(
			workshops.every(
				(item) =>
					item.parentResourceId === binding.anchorCohortId &&
					item.action === 'create',
			),
		).toBe(true)
		expect(lessons).toHaveLength(112)
		expect(
			lessons.every((item) =>
				workshops.some(
					(workshop) => workshop.targetResourceId === item.parentResourceId,
				),
			),
		).toBe(true)
		expect(
			first.plan.resources.some((item) => item.sourceKind === 'section'),
		).toBe(false)
		expect(first.plan.media).toEqual([])
		expect(
			await test.plane.evaluateBoundedAutoApply(first.run.runId),
		).toMatchObject({ eligible: true })
		for (const workshop of workshops) {
			expect(workshop.fields).not.toHaveProperty('startsAt')
			expect(workshop.fields).not.toHaveProperty('endsAt')
			expect(workshop.fields).not.toHaveProperty('timezone')
			expect(
				WorkshopSchema.safeParse({
					id: workshop.targetResourceId,
					type: 'workshop',
					fields: workshop.fields,
					createdById: 'test-writer',
					currentVersionId: null,
					slug: workshop.fields.slug,
					createdAt: new Date(),
					updatedAt: new Date(),
					deletedAt: null,
					resources: [],
					resourceProducts: [],
					organizationId: null,
					createdByOrganizationMembershipId: null,
					tags: [],
				}).success,
			).toBe(true)
		}
		await test.apply(first.run.runId, 'apply-first')
		expect(() =>
			assertCourseSyncTargetContract(binding, test.targetFacts()),
		).not.toThrow()
		const nextTick = await test.stage(
			{ ...manifest, courseVersionId: 'syllabus-next-tick' },
			'next-tick',
		)
		expect(
			nextTick.plan.resources.every((item) => item.action === 'retain'),
		).toBe(true)
	})

	it('drops eight ARCHIVE workshops and their placeholder lessons, compacts to seven (T10)', async () => {
		const test = harness()
		const first = await test.stage(syllabus('before-archive-drop'), 'before')
		await test.apply(first.run.runId, 'apply-before')
		const original = syllabus('after-archive-drop')
		const kept: CourseJsonDocumentV3 = {
			...original,
			sections: original.sections.filter(
				(section) => !section.title.startsWith('ARCHIVE'),
			),
		}
		const next = await test.stage(kept, 'after')
		expect(
			next.plan.resources.filter(
				(item) => item.sourceKind === 'workshop' && item.detached,
			),
		).toHaveLength(8)
		expect(
			next.plan.resources
				.filter((item) => item.sourceKind === 'workshop' && !item.detached)
				.map((item) => item.position),
		).toEqual([0, 1, 2, 3, 4, 5, 6])
		expect(next.plan.lessonRegressions).toEqual([])
		expect(
			await test.plane.evaluateBoundedAutoApply(next.run.runId),
		).toMatchObject({ eligible: true })
		await test.apply(next.run.runId, 'apply-archive-drop')
		expect(test.targetFacts().childRelations).toHaveLength(7)
		expect(() =>
			assertCourseSyncTargetContract(binding, test.targetFacts()),
		).not.toThrow()
		const nextTick = await test.stage(
			{ ...kept, courseVersionId: 'after-next-tick' },
			'after-next',
		)
		expect(nextTick.preview.state).toBe('previewed')
		expect(() =>
			assertCourseSyncTargetContract(binding, test.targetFacts()),
		).not.toThrow()
	})

	it('treats a filmed lesson under a removed workshop as an operator-review regression (T11)', async () => {
		const test = harness()
		const manifest = syllabus('filmed-before')
		const videoBytes = new TextEncoder().encode('synthetic video')
		const video = {
			id: 'video-filmed',
			relativePath: 'filmed/video.mp4',
			body: 'Filmed body',
			description: 'Filmed lesson',
			hash: 'render-filmed',
			sha256: createHash('sha256').update(videoBytes).digest('hex'),
			bytes: videoBytes.length,
			chapters: [],
		}
		const filmedManifest: CourseJsonDocumentV3 = {
			...manifest,
			sections: [
				{
					...manifest.sections[0]!,
					lessons: [
						{
							type: 'explainer',
							id: 'lesson-filmed',
							title: 'Filmed lesson',
							explainer: video,
						},
						...manifest.sections[0]!.lessons.slice(1),
					],
				},
				...manifest.sections.slice(1),
			],
		}
		const receipt = {
			sourceVideoId: video.id,
			relativePath: video.relativePath,
			providerRevision: 'dropbox-r1',
			providerContentHash: null,
			producerSha256: video.sha256,
			bytes: video.bytes,
			snapshotUri: null,
			muxAssetId: 'mux-filmed',
			muxPlaybackId: 'playback-filmed',
			duration: 60,
		}
		const initial = await test.plane.stageFrozen({
			bindingId: binding.bindingId,
			idempotencyKey: 'filmed-before',
			manifest: filmedManifest,
			frozenAssets: [receipt],
		})
		await test.plane.preview(initial.runId)
		await test.apply(initial.runId, 'apply-filmed')
		const source = syllabus('filmed-after')
		const changed: CourseJsonDocumentV3 = {
			...source,
			sections: source.sections.slice(1),
		}
		const next = await test.stage(changed, 'filmed-after')
		expect(
			next.plan.resources
				.filter((item) => item.detached)
				.map((item) => item.sourceKind),
		).toEqual(expect.arrayContaining(['workshop', 'lesson', 'video']))
		expect(next.plan.lessonRegressions).toEqual(['lesson-filmed'])
		expect(
			await test.plane.evaluateBoundedAutoApply(next.run.runId),
		).toMatchObject({
			eligible: false,
			failureCode: 'LESSON_REGRESSION_REVIEW_REQUIRED',
		})
	})

	it('rolls back a workshop create and verifies its tombstoned relation (T20)', async () => {
		const test = harness()
		const first = await test.stage(
			syllabus('rollback-before'),
			'rollback-before',
		)
		await test.apply(first.run.runId, 'apply-before-rollback')
		await expect(
			test.plane.rollback({
				runId: first.run.runId,
				idempotencyKey: 'rollback-workshop-create',
			}),
		).resolves.toMatchObject({ state: 'rolled_back' })
		const workshop = first.plan.resources.find(
			(item) => item.sourceKind === 'workshop',
		)!
		expect(
			test.persistence.relations.get(workshop.targetResourceId)?.detached,
		).toBe(true)
	})
})
