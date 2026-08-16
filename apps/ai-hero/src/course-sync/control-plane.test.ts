import { createHash } from 'node:crypto'
import { createActor } from 'xstate'
import type { CourseJsonDocumentV3 } from '@ai-hero/course-sync-schema'
import { describe, expect, it } from 'vitest'

import { createCourseSyncControlPlane } from './control-plane'
import { InMemoryCourseSyncPersistence } from './in-memory-persistence'
import { courseSyncRunMachine } from './run-machine'
import {
	AI_HERO_COURSE_SYNC_BINDING,
	type CourseSyncMuxAsset,
	type CourseSyncMuxClient,
	type CourseSyncMuxSourceResolver,
} from './types'

function bytesFor(videoNumber: number, revision = 'v1') {
	return new TextEncoder().encode(`video-${videoNumber}-${revision}`)
}

function fixture(courseVersionId = 'course-version-v1', changedVideo = 0) {
	let videoNumber = 0
	return {
		$schema: 'course.schema.json',
		schemaVersion: 3 as const,
		courseId: AI_HERO_COURSE_SYNC_BINDING.sourceCourseId,
		courseVersionId,
		archiveTTL: '90d' as const,
		courseName: 'Fixture Course',
		sections: Array.from({ length: 2 }, (_, sectionIndex) => ({
			id: `section-${sectionIndex + 1}`,
			title: `Section ${sectionIndex + 1}`,
			lessons: Array.from({ length: 8 }, (_, lessonIndex) => {
				videoNumber += 1
				const revision = videoNumber === changedVideo ? 'v2' : 'v1'
				const bytes = bytesFor(videoNumber, revision)
				return {
					type: 'explainer' as const,
					id: `lesson-${videoNumber}`,
					title: `Lesson ${videoNumber}`,
					explainer: {
						id: `video-${videoNumber}`,
						relativePath: `frozen/${sectionIndex + 1}/${lessonIndex + 1}/video-${videoNumber}.mp4`,
						body: `Body ${videoNumber}`,
						description: `Description ${videoNumber}`,
						hash: `render-${videoNumber}`,
						sha256: createHash('sha256').update(bytes).digest('hex'),
						bytes: bytes.byteLength,
						chapters: [],
					},
				}
			}),
		})),
	}
}

function exactDeltaFixture(
	courseVersionId: string,
	options: {
		changedVideos?: ReadonlySet<number>
		changedBodies?: ReadonlySet<number>
	} = {},
): CourseJsonDocumentV3 {
	let lessonNumber = 0
	let videoNumber = 0
	const makeVideo = (slot: 'explainer' | 'problem' | 'solution') => {
		videoNumber += 1
		const changed = options.changedVideos?.has(videoNumber) ?? false
		const revision = changed ? 'v2' : 'v1'
		const bytes = bytesFor(videoNumber, revision)
		return {
			id: `video-${videoNumber}`,
			relativePath: `versions/${courseVersionId}/video-${videoNumber}.mp4`,
			body:
				slot !== 'solution' && options.changedBodies?.has(lessonNumber)
					? `Body ${lessonNumber} revised`
					: `Body ${lessonNumber}`,
			description: `Description ${videoNumber}`,
			hash: `render-${videoNumber}-${revision}`,
			sha256: createHash('sha256').update(bytes).digest('hex'),
			bytes: bytes.byteLength,
			chapters: [],
		}
	}
	const lessons = Array.from({ length: 59 }, () => {
		lessonNumber += 1
		return lessonNumber <= 11
			? {
					type: 'problem' as const,
					id: `lesson-${lessonNumber}`,
					title: `Lesson ${lessonNumber}`,
					problem: makeVideo('problem'),
					solution: makeVideo('solution'),
				}
			: {
					type: 'explainer' as const,
					id: `lesson-${lessonNumber}`,
					title: `Lesson ${lessonNumber}`,
					explainer: makeVideo('explainer'),
				}
	})
	let lessonOffset = 0
	const sectionSizes = [10, 10, 10, 10, 10, 9]
	return {
		$schema: 'course.schema.json',
		schemaVersion: 3,
		courseId: AI_HERO_COURSE_SYNC_BINDING.sourceCourseId,
		courseVersionId,
		archiveTTL: '90d',
		courseName: 'Exact Delta Fixture',
		sections: sectionSizes.map((size, sectionIndex) => {
			const sectionLessons = lessons.slice(lessonOffset, lessonOffset + size)
			lessonOffset += size
			return {
				id: `section-${sectionIndex + 1}`,
				title: `Section ${sectionIndex + 1}`,
				lessons: sectionLessons,
			}
		}),
	}
}

function fixture060(): CourseJsonDocumentV3 {
	const manifest = fixture('course-version-0.6.0')
	const video = (videoNumber: number) => {
		const bytes = bytesFor(videoNumber)
		return {
			id: `video-${videoNumber}`,
			relativePath: `frozen/3/video-${videoNumber}.mp4`,
			body: `Body ${videoNumber}`,
			description: `Description ${videoNumber}`,
			hash: `render-${videoNumber}`,
			sha256: createHash('sha256').update(bytes).digest('hex'),
			bytes: bytes.byteLength,
			chapters: [],
		}
	}
	return {
		...manifest,
		sections: [
			...manifest.sections,
			{
				id: 'section-3',
				title: 'Fundamentals',
				lessons: [
					...Array.from({ length: 8 }, (_, index) => {
						const videoNumber = 17 + index
						return {
							type: 'explainer' as const,
							id: `lesson-${videoNumber}`,
							title: `Lesson ${videoNumber}`,
							explainer: video(videoNumber),
						}
					}),
					...Array.from({ length: 5 }, (_, index) => {
						const lessonNumber = 25 + index
						const problemVideoNumber = 25 + index * 2
						return {
							type: 'problem' as const,
							id: `lesson-${lessonNumber}`,
							title: `Lesson ${lessonNumber}`,
							problem: video(problemVideoNumber),
							solution: video(problemVideoNumber + 1),
						}
					}),
				],
			},
		],
	}
}

function harness(
	options: {
		changedVideo?: number
		changedVideosByCourseVersion?: ReadonlyMap<string, ReadonlySet<number>>
		targetValid?: boolean
		idStart?: number
	} = {},
) {
	const persistence = new InMemoryCourseSyncPersistence()
	persistence.targetValid = options.targetValid ?? true
	let reads = 0
	const muxSourceResolver: CourseSyncMuxSourceResolver = {
		async resolve({ courseVersionId, relativePath }) {
			reads += 1
			const match = /video-(\d+)\.mp4$/.exec(relativePath)
			if (!match) throw new Error('bad fixture path')
			const number = Number(match[1])
			const revision =
				number === options.changedVideo ||
				options.changedVideosByCourseVersion?.get(courseVersionId)?.has(number)
					? 'v2'
					: 'v1'
			const bytes = bytesFor(number, revision)
			return {
				url: `https://dropbox.test/${relativePath}`,
				providerRevision: `dropbox-rev-${number}-${revision}`,
				providerContentHash: `content-${number}-${revision}`,
				bytes: bytes.byteLength,
			}
		},
	}
	const snapshots: Array<{ key: string; bytes: number }> = []
	const muxAssets = new Map<string, CourseSyncMuxAsset>()
	const muxClient: CourseSyncMuxClient = {
		async getAsset(assetId) {
			return muxAssets.get(assetId) ?? null
		},
		async createAsset({ passthrough }) {
			const sourceVideoId = JSON.parse(passthrough).v as string
			const asset = {
				id: `mux-${sourceVideoId}`,
				status: 'ready' as const,
				playbackId: `playback-${sourceVideoId}`,
				duration: 60,
			}
			muxAssets.set(asset.id, asset)
			snapshots.push({ key: asset.id, bytes: 0 })
			return asset
		},
		async waitForReady(assetId) {
			const asset = muxAssets.get(assetId)
			if (!asset) throw new Error('missing mux asset')
			return asset
		},
	}
	let id = options.idStart ?? 0
	const controlPlane = createCourseSyncControlPlane({
		persistence,
		muxSourceResolver,
		muxClient,
		createdById: 'test-worker',
		makeId: (prefix) => `${prefix}_${++id}`,
		clock: () => new Date(`2026-07-17T00:00:0${id}.000Z`),
	})
	return { controlPlane, persistence, snapshots, reads: () => reads }
}

async function stagedAndPreviewed(
	testHarness: ReturnType<typeof harness>,
	manifest: CourseJsonDocumentV3 = fixture(),
	key = 'stage-key',
) {
	const staged = await testHarness.controlPlane.stage({
		bindingId: AI_HERO_COURSE_SYNC_BINDING.bindingId,
		idempotencyKey: key,
		manifest,
	})
	const previewed = await testHarness.controlPlane.preview(staged.runId)
	return { staged, previewed }
}

describe('draft course sync control plane', () => {
	it('models apply failure recovery explicitly and has no publish transition', () => {
		const actor = createActor(courseSyncRunMachine).start()
		expect(actor.getSnapshot().value).toBe('staged')
		actor.send({ type: 'PREVIEW' })
		actor.send({ type: 'APPLY' })
		actor.send({ type: 'FAIL' })
		expect(actor.getSnapshot().value).toBe('failed')
		actor.send({ type: 'RETRY' })
		expect(actor.getSnapshot().value).toBe('applying')
		actor.send({ type: 'APPLIED' })
		expect(actor.getSnapshot().value).toBe('applied')
		expect(courseSyncRunMachine.events).not.toContain('PUBLISH')
	})

	it('rejects an invalid target before reading or mutating Dropbox bytes', async () => {
		const testHarness = harness({ targetValid: false })
		await expect(
			testHarness.controlPlane.stage({
				bindingId: AI_HERO_COURSE_SYNC_BINDING.bindingId,
				idempotencyKey: 'stage-key',
				manifest: fixture(),
			}),
		).rejects.toMatchObject({ code: 'TARGET_CONTRACT_MISMATCH' })
		expect(testHarness.reads()).toBe(0)
		expect(testHarness.persistence.bindings.size).toBe(0)
		expect(testHarness.persistence.runs.size).toBe(0)
	})

	it('rechecks target state inside atomic apply before any writes', async () => {
		const testHarness = harness()
		const { staged } = await stagedAndPreviewed(testHarness)
		testHarness.persistence.beforeApplyTargetRecheck = () => {
			testHarness.persistence.targetValid = false
		}

		await expect(
			testHarness.controlPlane.apply({
				runId: staged.runId,
				idempotencyKey: 'apply-after-target-drift',
			}),
		).rejects.toMatchObject({ code: 'TARGET_CONTRACT_MISMATCH' })
		expect(testHarness.persistence.resources.size).toBe(0)
		expect(testHarness.persistence.versions.size).toBe(0)
		expect(testHarness.persistence.receipts).toHaveLength(0)
	})

	it('previews the exact launch delta with stable IDs and 18 media replacements', async () => {
		const changedVideos = new Set(
			Array.from({ length: 18 }, (_, index) => index + 1),
		)
		const changedBodies = new Set([57, 58])
		const testHarness = harness({
			changedVideosByCourseVersion: new Map([
				['course-version-current', changedVideos],
			]),
		})
		const baselineManifest = exactDeltaFixture('course-version-baseline')
		const baseline = await stagedAndPreviewed(
			testHarness,
			baselineManifest,
			'stage-exact-baseline',
		)
		await testHarness.controlPlane.apply({
			runId: baseline.staged.runId,
			idempotencyKey: 'apply-exact-baseline',
		})
		const baselinePlan = testHarness.persistence.runs.get(
			baseline.staged.runId,
		)?.plan
		expect(baselinePlan?.media).toHaveLength(70)

		const currentManifest = exactDeltaFixture('course-version-current', {
			changedVideos,
			changedBodies,
		})
		const current = await stagedAndPreviewed(
			testHarness,
			currentManifest,
			'stage-exact-current',
		)
		const currentPlan = testHarness.persistence.runs.get(
			current.staged.runId,
		)?.plan
		expect(
			currentPlan?.media.filter((item) => item.action === 'update'),
		).toHaveLength(18)
		expect(
			currentPlan?.media.filter((item) => item.action === 'retain'),
		).toHaveLength(52)
		expect(
			currentPlan?.resources.filter(
				(item) => item.sourceKind === 'video' && item.action === 'update',
			),
		).toHaveLength(18)
		for (const lessonId of ['lesson-57', 'lesson-58']) {
			const item = currentPlan?.resources.find(
				(resource) =>
					resource.sourceKind === 'lesson' && resource.sourceId === lessonId,
			)
			expect(item).toMatchObject({ action: 'update' })
			expect(item?.fields.body).toContain('revised')
		}
		expect(
			currentPlan?.resources.some((item) => item.action === 'create'),
		).toBe(false)
		expect(
			currentPlan?.resources.map((item) => item.targetResourceId).sort(),
		).toEqual(
			baselinePlan?.resources.map((item) => item.targetResourceId).sort(),
		)
		const baselineSlugs = new Map(
			baselinePlan?.resources.map((item) => [
				item.targetResourceId,
				item.fields.slug,
			]),
		)
		for (const item of currentPlan?.resources ?? []) {
			expect(item.fields.slug).toBe(baselineSlugs.get(item.targetResourceId))
		}
		expect(JSON.stringify(current.previewed)).not.toContain(
			AI_HERO_COURSE_SYNC_BINDING.productId,
		)
		expect(JSON.stringify(current.previewed)).not.toContain(
			AI_HERO_COURSE_SYNC_BINDING.anchorWorkshopId,
		)
	})

	it('freezes and stream-verifies a baseline v3 revision into one workshop', async () => {
		const testHarness = harness()
		const { staged, previewed } = await stagedAndPreviewed(testHarness)
		expect(staged.state).toBe('staged')
		expect(testHarness.reads()).toBe(16)
		expect(testHarness.snapshots).toHaveLength(16)
		expect(previewed).toMatchObject({
			state: 'previewed',
			resourceCounts: { create: 34, update: 0, retain: 0 },
		})
		const run = testHarness.persistence.runs.get(staged.runId)
		const sections = run?.plan?.resources.filter(
			(item) => item.sourceKind === 'section',
		)
		expect(sections).toHaveLength(2)
		expect(
			sections?.map((item) => [item.parentResourceId, item.position]),
		).toEqual([
			[AI_HERO_COURSE_SYNC_BINDING.anchorWorkshopId, 0],
			[AI_HERO_COURSE_SYNC_BINDING.anchorWorkshopId, 1],
		])
		expect(JSON.stringify(previewed)).not.toContain(
			AI_HERO_COURSE_SYNC_BINDING.productId,
		)
		expect(JSON.stringify(previewed)).not.toContain(
			AI_HERO_COURSE_SYNC_BINDING.anchorWorkshopId,
		)
	})

	it('reuses a ready binding-scoped Mux asset without resolving Dropbox again', async () => {
		const testHarness = harness()
		await testHarness.controlPlane.stage({
			bindingId: AI_HERO_COURSE_SYNC_BINDING.bindingId,
			idempotencyKey: 'stage-v1',
			manifest: fixture('course-version-v1'),
		})
		expect(testHarness.reads()).toBe(16)

		const next = fixture('course-version-v2')
		const frozen = await testHarness.controlPlane.freezeAsset({
			bindingId: AI_HERO_COURSE_SYNC_BINDING.bindingId,
			manifest: next,
			sourceVideoId: 'video-1',
		})
		expect(frozen).toMatchObject({
			muxAssetId: 'mux-video-1',
			muxPlaybackId: 'playback-video-1',
			duration: 60,
		})
		expect(testHarness.reads()).toBe(16)
		expect(testHarness.snapshots).toHaveLength(16)
	})

	it('accepts a 0.6.0-shaped three-section revision and maps sections by manifest order', async () => {
		const testHarness = harness()
		const { staged, previewed } = await stagedAndPreviewed(
			testHarness,
			fixture060(),
			'stage-0.6.0',
		)
		expect(testHarness.reads()).toBe(34)
		expect(testHarness.snapshots).toHaveLength(34)
		expect(previewed.resourceCounts).toEqual({
			create: 66,
			update: 0,
			retain: 0,
		})
		const sections = testHarness.persistence.runs
			.get(staged.runId)
			?.plan?.resources.filter((item) => item.sourceKind === 'section')
		expect(
			sections?.map((item) => [
				item.sourceId,
				item.parentResourceId,
				item.position,
			]),
		).toEqual([
			['section-1', AI_HERO_COURSE_SYNC_BINDING.anchorWorkshopId, 0],
			['section-2', AI_HERO_COURSE_SYNC_BINDING.anchorWorkshopId, 1],
			['section-3', AI_HERO_COURSE_SYNC_BINDING.anchorWorkshopId, 2],
		])
	})

	it('rejects an empty section list without reading source videos', async () => {
		const testHarness = harness()
		await expect(
			testHarness.controlPlane.stage({
				bindingId: AI_HERO_COURSE_SYNC_BINDING.bindingId,
				idempotencyKey: 'empty-sections',
				manifest: { ...fixture(), sections: [] },
			}),
		).rejects.toMatchObject({ code: 'SOURCE_SECTIONS_EMPTY' })
		expect(testHarness.reads()).toBe(0)
	})

	it('applies all versions atomically, returns no-op on replay, and compensates without deleting drafts', async () => {
		const testHarness = harness()
		const { staged } = await stagedAndPreviewed(testHarness)
		const applied = await testHarness.controlPlane.apply({
			runId: staged.runId,
			idempotencyKey: 'apply-key',
		})
		expect(applied.state).toBe('applied')
		expect(testHarness.persistence.resources.size).toBe(34)
		expect(
			[...testHarness.persistence.resources.values()].every(
				(resource) => resource.currentVersionId !== null,
			),
		).toBe(true)
		expect(testHarness.persistence.receipts).toHaveLength(34)
		const videoResources = [
			...testHarness.persistence.resources.values(),
		].filter((resource) => resource.type === 'videoResource')
		expect(videoResources).toHaveLength(16)
		expect(videoResources[0]?.fields).toMatchObject({
			state: 'ready',
			visibility: 'unlisted',
			muxAssetId: expect.stringMatching(/^mux-video-/),
			muxPlaybackId: expect.stringMatching(/^playback-video-/),
		})
		expect(
			[...testHarness.persistence.relations.values()].filter((relation) =>
				videoResources.some((video) => video.resourceId === relation.childId),
			),
		).toHaveLength(16)

		const replay = await testHarness.controlPlane.stage({
			bindingId: AI_HERO_COURSE_SYNC_BINDING.bindingId,
			idempotencyKey: 'another-stage-key',
			manifest: fixture(),
		})
		expect(replay).toMatchObject({ state: 'applied', noOp: true })
		expect(testHarness.reads()).toBe(16)
		expect(testHarness.persistence.versions.size).toBe(34)

		const rollback = await testHarness.controlPlane.rollback({
			runId: staged.runId,
			idempotencyKey: 'rollback-key',
		})
		expect(rollback.state).toBe('rolled_back')
		expect(testHarness.persistence.resources.size).toBe(34)
		expect(testHarness.persistence.versions.size).toBe(68)
		expect(
			[...testHarness.persistence.resources.values()].every(
				(resource) =>
					(resource.type === 'videoResource'
						? resource.fields.state === 'deleted'
						: resource.fields.state === 'draft') &&
					resource.fields.visibility === 'unlisted',
			),
		).toBe(true)
	})

	it('compensates relation ordering as well as resource versions', async () => {
		const testHarness = harness()
		const first = await stagedAndPreviewed(testHarness)
		await testHarness.controlPlane.apply({
			runId: first.staged.runId,
			idempotencyKey: 'apply-v1',
		})
		const reordered = fixture('course-version-reordered')
		reordered.sections[0]?.lessons.reverse()
		const second = await stagedAndPreviewed(
			testHarness,
			reordered,
			'stage-reordered',
		)
		const secondRun = testHarness.persistence.runs.get(second.staged.runId)
		const lessonOne = secondRun?.plan?.resources.find(
			(item) => item.sourceId === 'lesson-1',
		)
		expect(lessonOne).toMatchObject({ position: 7, previousPosition: 0 })
		if (!lessonOne) throw new Error('lesson-1 plan missing')
		await testHarness.controlPlane.apply({
			runId: second.staged.runId,
			idempotencyKey: 'apply-reordered',
		})
		expect(
			testHarness.persistence.relations.get(lessonOne.targetResourceId)
				?.position,
		).toBe(7)
		await testHarness.controlPlane.rollback({
			runId: second.staged.runId,
			idempotencyKey: 'rollback-reordered',
		})
		expect(
			testHarness.persistence.relations.get(lessonOne.targetResourceId)
				?.position,
		).toBe(0)
	})

	it('retries a rolled-back mid-apply failure with the same plan and key without duplicates', async () => {
		const testHarness = harness()
		const { staged } = await stagedAndPreviewed(testHarness)
		const planSha256 = testHarness.persistence.runs.get(
			staged.runId,
		)?.planSha256
		expect(planSha256).toHaveLength(64)
		testHarness.persistence.failAfterVersionWrites = 3
		await expect(
			testHarness.controlPlane.apply({
				runId: staged.runId,
				idempotencyKey: 'apply-failure-key',
			}),
		).rejects.toMatchObject({ code: 'INJECTED_APPLY_FAILURE' })
		expect(testHarness.persistence.resources.size).toBe(0)
		expect(testHarness.persistence.versions.size).toBe(0)
		expect(testHarness.persistence.relations.size).toBe(0)
		expect(testHarness.persistence.receipts).toHaveLength(0)
		expect(testHarness.persistence.runs.get(staged.runId)).toMatchObject({
			state: 'failed',
			applyIdempotencyKey: 'apply-failure-key',
			planSha256,
		})

		await expect(
			testHarness.controlPlane.apply({
				runId: staged.runId,
				idempotencyKey: 'another-apply-key',
			}),
		).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })

		testHarness.persistence.failAfterVersionWrites = null
		const retried = await testHarness.controlPlane.apply({
			runId: staged.runId,
			idempotencyKey: 'apply-failure-key',
		})
		expect(retried).toMatchObject({ state: 'applied', noOp: false })
		expect(testHarness.persistence.resources.size).toBe(34)
		expect(testHarness.persistence.versions.size).toBe(34)
		expect(testHarness.persistence.receipts).toHaveLength(34)

		const replay = await testHarness.controlPlane.apply({
			runId: staged.runId,
			idempotencyKey: 'apply-failure-key',
		})
		expect(replay).toMatchObject({ state: 'applied', noOp: true })
		expect(testHarness.persistence.resources.size).toBe(34)
		expect(testHarness.persistence.versions.size).toBe(34)
		expect(testHarness.persistence.relations.size).toBe(34)
		expect(testHarness.persistence.receipts).toHaveLength(34)
	})

	it('extracts questions, replays without churn, and detaches removed questions', async () => {
		const quizBody = `
<Quiz>
  <QuizQuestion data={{
    id: 'single', question: 'Single?', type: 'multiple-choice',
    choices: [{ answer: 'a' }, { answer: 'b' }], correct: 'b',
    answer: 'Because B.',
  }} />
  <QuizQuestion data={{
    id: 'multiple', question: 'Multiple?', type: 'multiple-choice',
    choices: [{ answer: 'a' }, { answer: 'b' }, { answer: 'c' }],
    correct: ['a', 'c'], allowMultiple: true, answer: 'A and C.',
  }} />
</Quiz>`
		const manifest = fixture('quiz-v1')
		const firstLesson = manifest.sections[0]?.lessons[0]
		if (!firstLesson || firstLesson.type !== 'explainer') {
			throw new Error('quiz fixture lesson missing')
		}
		firstLesson.explainer.body = quizBody

		const testHarness = harness()
		const first = await stagedAndPreviewed(
			testHarness,
			manifest,
			'stage-quiz-v1',
		)
		expect(first.previewed.resourceCounts).toEqual({
			create: 36,
			update: 0,
			retain: 0,
		})
		const firstPlan = testHarness.persistence.runs.get(first.staged.runId)?.plan
		const questions = firstPlan?.resources.filter(
			(item) => item.sourceKind === 'question',
		)
		expect(questions).toHaveLength(2)
		expect(questions?.[1]).toMatchObject({
			sourceId: 'multiple',
			position: 1,
			fields: {
				correct: ['a', 'c'],
				allowMultiple: true,
				answer: 'A and C.',
			},
		})
		await testHarness.controlPlane.apply({
			runId: first.staged.runId,
			idempotencyKey: 'apply-quiz-v1',
		})
		const questionId = questions?.[1]?.targetResourceId
		if (!questionId) throw new Error('derived question missing')
		const versionCount = testHarness.persistence.versions.size

		const replay = await testHarness.controlPlane.stage({
			bindingId: AI_HERO_COURSE_SYNC_BINDING.bindingId,
			idempotencyKey: 'stage-quiz-replay',
			manifest,
		})
		expect(replay).toMatchObject({ state: 'applied', noOp: true })
		expect(testHarness.persistence.resources.size).toBe(36)
		expect(testHarness.persistence.versions.size).toBe(versionCount)

		const removed = structuredClone(manifest)
		removed.courseVersionId = 'quiz-v2'
		const removedLesson = removed.sections[0]?.lessons[0]
		if (!removedLesson || removedLesson.type !== 'explainer') {
			throw new Error('removed quiz fixture lesson missing')
		}
		removedLesson.explainer.body = quizBody.replace(
			/\n  <QuizQuestion data=\{\{\n    id: 'multiple'[\s\S]*?\n  \}\} \/>/,
			'',
		)
		const second = await stagedAndPreviewed(
			testHarness,
			removed,
			'stage-quiz-v2',
		)
		expect(second.previewed.resourceCounts).toEqual({
			create: 0,
			update: 2,
			retain: 34,
		})
		await testHarness.controlPlane.apply({
			runId: second.staged.runId,
			idempotencyKey: 'apply-quiz-v2',
		})
		expect(testHarness.persistence.resources.has(questionId)).toBe(true)
		expect(testHarness.persistence.relations.get(questionId)?.detached).toBe(
			true,
		)

		await testHarness.controlPlane.rollback({
			runId: second.staged.runId,
			idempotencyKey: 'rollback-quiz-v2',
		})
		expect(testHarness.persistence.resources.has(questionId)).toBe(true)
		expect(testHarness.persistence.relations.get(questionId)?.detached).toBe(
			false,
		)

		removed.courseVersionId = 'quiz-v2-detached-again'
		const detachedAgain = await stagedAndPreviewed(
			testHarness,
			removed,
			'stage-quiz-v2-detached-again',
		)
		await testHarness.controlPlane.apply({
			runId: detachedAgain.staged.runId,
			idempotencyKey: 'apply-quiz-v2-detached-again',
		})
		expect(testHarness.persistence.relations.get(questionId)?.detached).toBe(
			true,
		)

		const restored = structuredClone(manifest)
		restored.courseVersionId = 'quiz-v3'
		const third = await stagedAndPreviewed(
			testHarness,
			restored,
			'stage-quiz-v3',
		)
		await testHarness.controlPlane.apply({
			runId: third.staged.runId,
			idempotencyKey: 'apply-quiz-v3',
		})
		expect(testHarness.persistence.resources.size).toBe(36)
		expect(testHarness.persistence.relations.get(questionId)?.detached).toBe(
			false,
		)
	})

	it('rejects missing and duplicate question ids before reading source assets', async () => {
		for (const [label, body, offendingId] of [
			[
				'missing',
				`<QuizQuestion data={{ question: 'Missing', type: 'essay' }} />`,
				'<missing>',
			],
			[
				'duplicate',
				`<QuizQuestion data={{ id: 'same', question: 'One', type: 'essay' }} />\n<QuizQuestion data={{ id: 'same', question: 'Two', type: 'essay' }} />`,
				'same',
			],
		] as const) {
			const manifest = fixture(`invalid-${label}`)
			const lesson = manifest.sections[0]?.lessons[0]
			if (!lesson || lesson.type !== 'explainer') {
				throw new Error('invalid quiz fixture lesson missing')
			}
			lesson.explainer.body = body
			const testHarness = harness()
			await expect(
				testHarness.controlPlane.stage({
					bindingId: AI_HERO_COURSE_SYNC_BINDING.bindingId,
					idempotencyKey: `stage-invalid-${label}`,
					manifest,
				}),
			).rejects.toMatchObject({
				code: 'INVALID_QUIZ_QUESTION',
				message: expect.stringContaining(
					`Lesson lesson-1 has invalid QuizQuestion id ${offendingId}`,
				),
			})
			expect(testHarness.reads()).toBe(0)
		}
	})

	it('diffs a new revision and changes only the one lesson whose frozen media changed', async () => {
		const first = harness()
		const { staged } = await stagedAndPreviewed(first)
		await first.controlPlane.apply({
			runId: staged.runId,
			idempotencyKey: 'apply-v1',
		})

		const changed = fixture('course-version-v2', 7)
		const changedReaderHarness = harness({ changedVideo: 7, idStart: 100 })
		changedReaderHarness.persistence.bindings.clear()
		for (const [key, value] of first.persistence.bindings)
			changedReaderHarness.persistence.bindings.set(key, value)
		for (const [key, value] of first.persistence.revisions)
			changedReaderHarness.persistence.revisions.set(key, value)
		for (const [key, value] of first.persistence.runs)
			changedReaderHarness.persistence.runs.set(key, value)
		for (const [key, value] of first.persistence.resources)
			changedReaderHarness.persistence.resources.set(key, value)
		for (const [key, value] of first.persistence.versions)
			changedReaderHarness.persistence.versions.set(key, value)
		for (const [key, value] of first.persistence.relations)
			changedReaderHarness.persistence.relations.set(key, value)
		changedReaderHarness.persistence.receipts.push(
			...first.persistence.receipts,
		)

		const second = await stagedAndPreviewed(
			changedReaderHarness,
			changed,
			'stage-v2',
		)
		expect(second.previewed.resourceCounts).toEqual({
			create: 0,
			update: 2,
			retain: 32,
		})
		const plan = changedReaderHarness.persistence.runs.get(
			second.staged.runId,
		)?.plan
		expect(plan?.media.filter((item) => item.action === 'update')).toHaveLength(
			1,
		)
	})
})
