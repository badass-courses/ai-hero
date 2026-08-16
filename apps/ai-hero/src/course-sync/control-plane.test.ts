import { createHash } from 'node:crypto'
import { createActor } from 'xstate'
import {
	courseJsonVideos,
	type CourseJsonDocumentV3,
} from '@ai-hero/course-sync-schema'
import { describe, expect, it } from 'vitest'

import {
	courseSyncRollbackStageIdempotencyKey,
	createCourseSyncControlPlane,
} from './control-plane'
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
		changedExportHashes?: ReadonlySet<number>
		changedBodies?: ReadonlySet<number>
	} = {},
): CourseJsonDocumentV3 {
	let lessonNumber = 0
	let videoNumber = 0
	const makeVideo = (slot: 'explainer' | 'problem' | 'solution') => {
		videoNumber += 1
		const mediaChanged = options.changedVideos?.has(videoNumber) ?? false
		const exportChanged = options.changedExportHashes?.has(videoNumber) ?? false
		const mediaRevision = mediaChanged ? 'v2' : 'v1'
		const exportRevision = exportChanged ? 'v2' : 'v1'
		const bytes = bytesFor(videoNumber, mediaRevision)
		return {
			id: `video-${videoNumber}`,
			relativePath: `versions/${courseVersionId}/video-${videoNumber}.mp4`,
			body:
				slot !== 'solution' && options.changedBodies?.has(lessonNumber)
					? `Body ${lessonNumber} revised`
					: `Body ${lessonNumber}`,
			description: `Description ${videoNumber}`,
			hash: `render-${videoNumber}-${exportRevision}`,
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
		failMuxCreateAt?: number
		failMuxWaitOnceFor?: number
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
	let muxCreateCalls = 0
	const failedWaits = new Set<number>()
	const muxClient: CourseSyncMuxClient = {
		async getAsset(assetId) {
			return muxAssets.get(assetId) ?? null
		},
		async createAsset({ passthrough }) {
			muxCreateCalls += 1
			if (muxCreateCalls === options.failMuxCreateAt) {
				throw new Error('injected Mux create failure')
			}
			const sourceVideoId = JSON.parse(passthrough).v as string
			const sourceVideoNumber = Number(sourceVideoId.replace('video-', ''))
			const preparing = sourceVideoNumber === options.failMuxWaitOnceFor
			const asset: CourseSyncMuxAsset = {
				id: `mux-${sourceVideoId}`,
				status: preparing ? 'preparing' : 'ready',
				playbackId: preparing ? null : `playback-${sourceVideoId}`,
				duration: preparing ? null : 60,
			}
			muxAssets.set(asset.id, asset)
			snapshots.push({ key: asset.id, bytes: 0 })
			return asset
		},
		async waitForReady(assetId) {
			const asset = muxAssets.get(assetId)
			if (!asset) throw new Error('missing mux asset')
			const sourceVideoNumber = Number(assetId.replace('mux-video-', ''))
			if (
				sourceVideoNumber === options.failMuxWaitOnceFor &&
				!failedWaits.has(sourceVideoNumber)
			) {
				failedWaits.add(sourceVideoNumber)
				throw new Error('injected Mux wait failure')
			}
			const ready: CourseSyncMuxAsset = {
				...asset,
				status: 'ready',
				playbackId: `playback-video-${sourceVideoNumber}`,
				duration: 60,
			}
			muxAssets.set(assetId, ready)
			return ready
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
	return {
		controlPlane,
		persistence,
		snapshots,
		reads: () => reads,
		muxCreates: () => muxCreateCalls,
	}
}

async function applyDirectly(
	testHarness: ReturnType<typeof harness>,
	runId: string,
	idempotencyKey: string,
) {
	const run = testHarness.persistence.runs.get(runId)
	if (!run?.plan) throw new Error('previewed run plan missing')
	return testHarness.persistence.applyAtomically({
		runId,
		plan: run.plan,
		idempotencyKey,
		createdById: 'test-worker',
	})
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
			applyDirectly(testHarness, staged.runId, 'apply-after-target-drift'),
		).rejects.toMatchObject({ code: 'TARGET_CONTRACT_MISMATCH' })
		expect(testHarness.persistence.resources.size).toBe(0)
		expect(testHarness.persistence.versions.size).toBe(0)
		expect(testHarness.persistence.receipts).toHaveLength(0)
	})

	it('previews the exact 19 export, 18 media, and 2 body launch delta', async () => {
		const changedExportHashes = new Set([
			...Array.from({ length: 11 }, (_, index) => index * 2 + 1),
			...Array.from({ length: 8 }, (_, index) => index + 23),
		])
		const changedVideos = new Set([...changedExportHashes].slice(0, 18))
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
		await applyDirectly(
			testHarness,
			baseline.staged.runId,
			'apply-exact-baseline',
		)
		const baselinePlan = testHarness.persistence.runs.get(
			baseline.staged.runId,
		)?.plan
		expect(baselinePlan?.media).toHaveLength(70)

		const currentManifest = exactDeltaFixture('course-version-current', {
			changedVideos,
			changedExportHashes,
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
		expect(
			currentPlan?.resources.filter(
				(item) => item.sourceKind === 'video' && item.action === 'retain',
			),
		).toHaveLength(52)
		for (const lessonId of ['lesson-57', 'lesson-58']) {
			const item = currentPlan?.resources.find(
				(resource) =>
					resource.sourceKind === 'lesson' && resource.sourceId === lessonId,
			)
			expect(item).toMatchObject({ action: 'update' })
			expect(item?.fields.body).toContain('revised')
		}
		const baselineExportHashes = new Map(
			courseJsonVideos(baselineManifest).map((video) => [video.id, video.hash]),
		)
		expect(
			courseJsonVideos(currentManifest).filter(
				(video) => baselineExportHashes.get(video.id) !== video.hash,
			),
		).toHaveLength(19)
		expect(
			currentPlan?.resources.filter(
				(item) => item.sourceKind === 'lesson' && item.action === 'update',
			),
		).toHaveLength(21)
		expect(
			currentPlan?.resources.filter(
				(item) => item.sourceKind === 'lesson' && item.action === 'retain',
			),
		).toHaveLength(38)
		expect(
			currentPlan?.resources.filter(
				(item) => item.sourceKind === 'section' && item.action === 'retain',
			),
		).toHaveLength(6)
		expect(
			currentPlan?.resources.filter((item) => item.action === 'update'),
		).toHaveLength(39)
		expect(
			currentPlan?.resources.filter((item) => item.action === 'retain'),
		).toHaveLength(96)
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
		await expect(
			testHarness.controlPlane.apply({
				runId: current.staged.runId,
				idempotencyKey: 'apply-exact-current',
			}),
		).resolves.toMatchObject({ state: 'applied' })
	})

	it('rejects a reviewed topology change before any apply write', async () => {
		const changedExportHashes = new Set([
			...Array.from({ length: 11 }, (_, index) => index * 2 + 1),
			...Array.from({ length: 8 }, (_, index) => index + 23),
		])
		const changedVideos = new Set([...changedExportHashes].slice(0, 18))
		const changedBodies = new Set([57, 58])
		const testHarness = harness({
			changedVideosByCourseVersion: new Map([
				['course-version-policy-current', changedVideos],
			]),
		})
		const baseline = await stagedAndPreviewed(
			testHarness,
			exactDeltaFixture('course-version-policy-baseline'),
			'stage-policy-baseline',
		)
		await applyDirectly(
			testHarness,
			baseline.staged.runId,
			'apply-policy-baseline',
		)
		const current = await stagedAndPreviewed(
			testHarness,
			exactDeltaFixture('course-version-policy-current', {
				changedVideos,
				changedExportHashes,
				changedBodies,
			}),
			'stage-policy-current',
		)
		const run = testHarness.persistence.runs.get(current.staged.runId)
		const changedItem = run?.plan?.resources[0]
		if (!run?.plan || !changedItem) throw new Error('policy plan missing')
		changedItem.position += 1
		const before = structuredClone({
			runs: [...testHarness.persistence.runs],
			resources: [...testHarness.persistence.resources],
			versions: [...testHarness.persistence.versions],
			relations: [...testHarness.persistence.relations],
			receipts: testHarness.persistence.receipts,
			currentAppliedRunId: testHarness.persistence.currentAppliedRunId,
		})

		await expect(
			testHarness.controlPlane.apply({
				runId: current.staged.runId,
				idempotencyKey: 'apply-policy-reparent',
			}),
		).rejects.toMatchObject({
			code: 'LAUNCH_APPLY_POLICY_VIOLATION',
			retryable: false,
		})
		expect(
			structuredClone({
				runs: [...testHarness.persistence.runs],
				resources: [...testHarness.persistence.resources],
				versions: [...testHarness.persistence.versions],
				relations: [...testHarness.persistence.relations],
				receipts: testHarness.persistence.receipts,
				currentAppliedRunId: testHarness.persistence.currentAppliedRunId,
			}),
		).toEqual(before)
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

	it('reuses each successful freeze receipt after a later asset fails', async () => {
		const testHarness = harness({ failMuxCreateAt: 2 })
		const source = fixture()
		await expect(
			testHarness.controlPlane.freezeAsset({
				bindingId: AI_HERO_COURSE_SYNC_BINDING.bindingId,
				manifest: source,
				sourceVideoId: 'video-1',
			}),
		).resolves.toMatchObject({ muxAssetId: 'mux-video-1' })
		await expect(
			testHarness.controlPlane.freezeAsset({
				bindingId: AI_HERO_COURSE_SYNC_BINDING.bindingId,
				manifest: source,
				sourceVideoId: 'video-2',
			}),
		).rejects.toThrow('injected Mux create failure')
		expect(testHarness.muxCreates()).toBe(2)

		const retriedFirst = await testHarness.controlPlane.freezeAsset({
			bindingId: AI_HERO_COURSE_SYNC_BINDING.bindingId,
			manifest: source,
			sourceVideoId: 'video-1',
		})
		expect(retriedFirst.freezeEffects).toEqual({
			sourceAssetsRead: 0,
			muxAssetsCreated: 0,
		})
		expect(testHarness.muxCreates()).toBe(2)
		await expect(
			testHarness.controlPlane.freezeAsset({
				bindingId: AI_HERO_COURSE_SYNC_BINDING.bindingId,
				manifest: source,
				sourceVideoId: 'video-2',
			}),
		).resolves.toMatchObject({ muxAssetId: 'mux-video-2' })
		expect(testHarness.muxCreates()).toBe(3)
	})

	it('reconciles a provisional Mux receipt after readiness polling fails', async () => {
		const testHarness = harness({ failMuxWaitOnceFor: 1 })
		const source = fixture()
		await expect(
			testHarness.controlPlane.freezeAsset({
				bindingId: AI_HERO_COURSE_SYNC_BINDING.bindingId,
				manifest: source,
				sourceVideoId: 'video-1',
			}),
		).rejects.toThrow('injected Mux wait failure')
		expect(testHarness.muxCreates()).toBe(1)
		expect(testHarness.persistence.frozenAssetReceipts.size).toBe(1)

		await expect(
			testHarness.controlPlane.freezeAsset({
				bindingId: AI_HERO_COURSE_SYNC_BINDING.bindingId,
				manifest: source,
				sourceVideoId: 'video-1',
			}),
		).resolves.toMatchObject({
			muxAssetId: 'mux-video-1',
			muxPlaybackId: 'playback-video-1',
			freezeEffects: { sourceAssetsRead: 0, muxAssetsCreated: 0 },
		})
		expect(testHarness.muxCreates()).toBe(1)
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
		const applied = await applyDirectly(testHarness, staged.runId, 'apply-key')
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

	it('hashes a maximum-length rollback key into the compensating run column', async () => {
		const testHarness = harness()
		const { staged } = await stagedAndPreviewed(testHarness)
		await applyDirectly(
			testHarness,
			staged.runId,
			'apply-before-long-rollback-key',
		)

		await testHarness.controlPlane.rollback({
			runId: staged.runId,
			idempotencyKey: 'r'.repeat(255),
		})

		const original = testHarness.persistence.runs.get(staged.runId)
		const compensating = original?.compensatingRunId
			? testHarness.persistence.runs.get(original.compensatingRunId)
			: null
		const expectedKey = courseSyncRollbackStageIdempotencyKey(
			staged.runId,
			'r'.repeat(255),
		)
		expect(compensating?.stageIdempotencyKey).toBe(expectedKey)
		expect(compensating?.stageIdempotencyKey).toMatch(/^[a-f0-9]{64}$/)
		expect(compensating?.stageIdempotencyKey).toHaveLength(64)
		expect(
			courseSyncRollbackStageIdempotencyKey(staged.runId, 'r'.repeat(255)),
		).toBe(expectedKey)
	})

	it('blocks relation reordering under the supervised launch policy', async () => {
		const testHarness = harness()
		const first = await stagedAndPreviewed(testHarness)
		await applyDirectly(testHarness, first.staged.runId, 'apply-v1')
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
		await expect(
			testHarness.controlPlane.apply({
				runId: second.staged.runId,
				idempotencyKey: 'apply-reordered',
			}),
		).rejects.toMatchObject({
			code: 'LAUNCH_APPLY_POLICY_VIOLATION',
			retryable: false,
		})
		expect(
			testHarness.persistence.relations.get(lessonOne.targetResourceId)
				?.position,
		).toBe(0)
	})

	it('restores updated fields, preserves retained fields, and tombstones created resources', async () => {
		const testHarness = harness()
		const baseline = await stagedAndPreviewed(testHarness)
		await applyDirectly(
			testHarness,
			baseline.staged.runId,
			'apply-rollback-field-baseline',
		)

		const revision = fixture('rollback-field-cases', 1)
		const lesson = revision.sections[0]?.lessons[0]
		if (!lesson || lesson.type !== 'explainer') {
			throw new Error('rollback field fixture lesson missing')
		}
		lesson.explainer.body += `\n<QuizQuestion data={{ id: 'rollback-created', question: 'Created?', type: 'essay' }} />`
		const changed = await stagedAndPreviewed(
			testHarness,
			revision,
			'stage-rollback-field-cases',
		)
		const plan = testHarness.persistence.runs.get(changed.staged.runId)?.plan
		const updatedItem = plan?.resources.find(
			(item) => item.action === 'update' && item.sourceKind === 'lesson',
		)
		const retainedItem = plan?.resources.find(
			(item) => item.action === 'retain' && item.sourceKind === 'lesson',
		)
		const createdItem = plan?.resources.find(
			(item) => item.action === 'create' && item.sourceKind === 'question',
		)
		if (!updatedItem || !retainedItem || !createdItem) {
			throw new Error('rollback field plan cases missing')
		}
		const updatedBefore = structuredClone(
			testHarness.persistence.resources.get(updatedItem.targetResourceId),
		)
		const updatedRelationBefore = structuredClone(
			testHarness.persistence.relations.get(updatedItem.targetResourceId),
		)
		const retainedBefore = structuredClone(
			testHarness.persistence.resources.get(retainedItem.targetResourceId),
		)
		const retainedRelationBefore = structuredClone(
			testHarness.persistence.relations.get(retainedItem.targetResourceId),
		)

		await applyDirectly(
			testHarness,
			changed.staged.runId,
			'apply-rollback-field-cases',
		)
		expect(
			testHarness.persistence.resources.get(updatedItem.targetResourceId)
				?.fields,
		).not.toEqual(updatedBefore?.fields)
		await testHarness.controlPlane.rollback({
			runId: changed.staged.runId,
			idempotencyKey: 'rollback-field-cases',
		})

		expect(
			testHarness.persistence.resources.get(updatedItem.targetResourceId)
				?.fields,
		).toEqual(updatedBefore?.fields)
		expect(
			testHarness.persistence.relations.get(updatedItem.targetResourceId),
		).toEqual(updatedRelationBefore)
		expect(
			testHarness.persistence.resources.get(retainedItem.targetResourceId),
		).toEqual(retainedBefore)
		expect(
			testHarness.persistence.relations.get(retainedItem.targetResourceId),
		).toEqual(retainedRelationBefore)
		expect(
			testHarness.persistence.resources.get(createdItem.targetResourceId)
				?.fields,
		).toMatchObject({
			state: 'draft',
			visibility: 'unlisted',
			courseSync: {
				active: false,
				rollbackOfRunId: changed.staged.runId,
			},
		})
		expect(
			testHarness.persistence.relations.get(createdItem.targetResourceId),
		).toMatchObject({ detached: true })
	})

	it('leaves all in-memory state unchanged when a mixed create/update rollback fails during preparation', async () => {
		const testHarness = harness()
		const baseline = await stagedAndPreviewed(testHarness)
		await applyDirectly(
			testHarness,
			baseline.staged.runId,
			'apply-atomic-rollback-baseline',
		)
		const revision = fixture('mixed-create-update-rollback', 1)
		const lesson = revision.sections[0]?.lessons[0]
		if (!lesson || lesson.type !== 'explainer') {
			throw new Error('mixed rollback lesson missing')
		}
		lesson.explainer.body += `\n<QuizQuestion data={{ id: 'mixed-created', question: 'Created?', type: 'essay' }} />`
		const changed = await stagedAndPreviewed(
			testHarness,
			revision,
			'stage-mixed-create-update-rollback',
		)
		await applyDirectly(
			testHarness,
			changed.staged.runId,
			'apply-mixed-create-update-rollback',
		)
		const changedRun = testHarness.persistence.runs.get(changed.staged.runId)
		const createItem = changedRun?.plan?.resources.find(
			(item) => item.action === 'create',
		)
		const updateItem = changedRun?.plan?.resources.find(
			(item) => item.action === 'update' && item.previousVersionId !== null,
		)
		if (!createItem || !updateItem?.previousVersionId) {
			throw new Error('mixed rollback plan cases missing')
		}
		const runReceipts = testHarness.persistence.receipts.filter(
			(receipt) => receipt.runId === changed.staged.runId,
		)
		const createReceipt = runReceipts.find(
			(receipt) => receipt.resourceId === createItem.targetResourceId,
		)
		const updateReceipt = runReceipts.find(
			(receipt) => receipt.resourceId === updateItem.targetResourceId,
		)
		if (!createReceipt || !updateReceipt) {
			throw new Error('mixed rollback receipts missing')
		}
		const otherReceipts = testHarness.persistence.receipts.filter(
			(receipt) => receipt !== createReceipt && receipt !== updateReceipt,
		)
		testHarness.persistence.receipts.splice(
			0,
			testHarness.persistence.receipts.length,
			...otherReceipts.filter(
				(receipt) => receipt.runId !== changed.staged.runId,
			),
			createReceipt,
			updateReceipt,
			...runReceipts.filter(
				(receipt) => receipt !== createReceipt && receipt !== updateReceipt,
			),
		)
		testHarness.persistence.versions.delete(updateItem.previousVersionId)
		const before = structuredClone({
			runs: [...testHarness.persistence.runs],
			resources: [...testHarness.persistence.resources],
			versions: [...testHarness.persistence.versions],
			relations: [...testHarness.persistence.relations],
			receipts: testHarness.persistence.receipts,
			currentAppliedRunId: testHarness.persistence.currentAppliedRunId,
		})

		await expect(
			testHarness.persistence.rollbackAtomically({
				runId: changed.staged.runId,
				bindingId: AI_HERO_COURSE_SYNC_BINDING.bindingId,
				idempotencyKey: 'rollback-mixed-create-update-failure',
				compensatingRunId: 'csr_run_failed_mixed_rollback',
				createdById: 'test-worker',
			}),
		).rejects.toMatchObject({ code: 'ROLLBACK_PARENT_VERSION_MISSING' })
		expect(
			structuredClone({
				runs: [...testHarness.persistence.runs],
				resources: [...testHarness.persistence.resources],
				versions: [...testHarness.persistence.versions],
				relations: [...testHarness.persistence.relations],
				receipts: testHarness.persistence.receipts,
				currentAppliedRunId: testHarness.persistence.currentAppliedRunId,
			}),
		).toEqual(before)
	})

	it('rejects locked resource-field and relation drift after preview', async () => {
		const fieldsHarness = harness()
		const baseline = await stagedAndPreviewed(fieldsHarness)
		await applyDirectly(
			fieldsHarness,
			baseline.staged.runId,
			'apply-drift-baseline',
		)
		const changed = await stagedAndPreviewed(
			fieldsHarness,
			fixture('drift-fields', 1),
			'stage-drift-fields',
		)
		const changedItem = fieldsHarness.persistence.runs
			.get(changed.staged.runId)
			?.plan?.resources.find((item) => item.action === 'update')
		if (!changedItem) throw new Error('changed plan item missing')
		const changedResource = fieldsHarness.persistence.resources.get(
			changedItem.targetResourceId,
		)
		if (!changedResource) throw new Error('changed resource missing')
		changedResource.fields = {
			...changedResource.fields,
			title: 'Manual edit',
		}
		await expect(
			applyDirectly(
				fieldsHarness,
				changed.staged.runId,
				'apply-after-field-drift',
			),
		).rejects.toMatchObject({ code: 'APPLY_TARGET_CHANGED' })

		const relationHarness = harness()
		const relationBaseline = await stagedAndPreviewed(relationHarness)
		await applyDirectly(
			relationHarness,
			relationBaseline.staged.runId,
			'apply-relation-baseline',
		)
		const relationChange = await stagedAndPreviewed(
			relationHarness,
			fixture('drift-relation', 1),
			'stage-drift-relation',
		)
		const relationItem = relationHarness.persistence.runs
			.get(relationChange.staged.runId)
			?.plan?.resources.find((item) => item.action === 'update')
		if (!relationItem) throw new Error('relation plan item missing')
		const relation = relationHarness.persistence.relations.get(
			relationItem.targetResourceId,
		)
		if (!relation) throw new Error('managed relation missing')
		relation.position += 1
		await expect(
			applyDirectly(
				relationHarness,
				relationChange.staged.runId,
				'apply-after-relation-drift',
			),
		).rejects.toMatchObject({ code: 'MANAGED_RELATION_MISSING' })
	})

	it('rejects preview A after revision B becomes the awaiting head', async () => {
		const testHarness = harness()
		const revisionA = await stagedAndPreviewed(
			testHarness,
			fixture('revision-a'),
			'stage-revision-a',
		)
		const revisionB = await stagedAndPreviewed(
			testHarness,
			fixture('revision-b'),
			'stage-revision-b',
		)
		expect(
			testHarness.persistence.runs.get(revisionA.staged.runId)?.state,
		).toBe('superseded')
		await expect(
			testHarness.controlPlane.apply({
				runId: revisionA.staged.runId,
				idempotencyKey: 'apply-stale-a',
			}),
		).rejects.toMatchObject({ code: 'INVALID_RUN_STATE' })
		await expect(
			applyDirectly(testHarness, revisionB.staged.runId, 'apply-current-b'),
		).resolves.toMatchObject({ state: 'applied' })
	})

	it('aborts rollback after a later edit or later apply', async () => {
		const editedHarness = harness()
		const first = await stagedAndPreviewed(editedHarness)
		await applyDirectly(editedHarness, first.staged.runId, 'apply-before-edit')
		const receipt = editedHarness.persistence.receipts.find(
			(candidate) => candidate.runId === first.staged.runId,
		)
		if (!receipt) throw new Error('apply receipt missing')
		const edited = editedHarness.persistence.resources.get(receipt.resourceId)
		if (!edited) throw new Error('applied resource missing')
		edited.currentVersionId = 'manual-editor-version'
		await expect(
			editedHarness.controlPlane.rollback({
				runId: first.staged.runId,
				idempotencyKey: 'rollback-after-edit',
			}),
		).rejects.toMatchObject({ code: 'ROLLBACK_TARGET_CHANGED' })

		const laterHarness = harness()
		const revisionA = await stagedAndPreviewed(
			laterHarness,
			fixture('rollback-a'),
			'stage-rollback-a',
		)
		await applyDirectly(
			laterHarness,
			revisionA.staged.runId,
			'apply-rollback-a',
		)
		const revisionB = await stagedAndPreviewed(
			laterHarness,
			fixture('rollback-b', 1),
			'stage-rollback-b',
		)
		await applyDirectly(
			laterHarness,
			revisionB.staged.runId,
			'apply-rollback-b',
		)
		await expect(
			laterHarness.controlPlane.rollback({
				runId: revisionA.staged.runId,
				idempotencyKey: 'rollback-old-a',
			}),
		).rejects.toMatchObject({ code: 'ROLLBACK_CONCURRENCY_CONFLICT' })
	})

	it('retries a rolled-back mid-apply failure with the same exact launch plan and key', async () => {
		const changedExportHashes = new Set([
			...Array.from({ length: 11 }, (_, index) => index * 2 + 1),
			...Array.from({ length: 8 }, (_, index) => index + 23),
		])
		const changedVideos = new Set([...changedExportHashes].slice(0, 18))
		const testHarness = harness({
			changedVideosByCourseVersion: new Map([
				['course-version-failure-current', changedVideos],
			]),
		})
		const baseline = await stagedAndPreviewed(
			testHarness,
			exactDeltaFixture('course-version-failure-baseline'),
			'stage-failure-baseline',
		)
		await applyDirectly(
			testHarness,
			baseline.staged.runId,
			'apply-failure-baseline',
		)
		const { staged } = await stagedAndPreviewed(
			testHarness,
			exactDeltaFixture('course-version-failure-current', {
				changedVideos,
				changedExportHashes,
				changedBodies: new Set([57, 58]),
			}),
			'stage-failure-current',
		)
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
		expect(testHarness.persistence.resources.size).toBe(135)
		expect(testHarness.persistence.versions.size).toBe(135)
		expect(testHarness.persistence.relations.size).toBe(135)
		expect(testHarness.persistence.receipts).toHaveLength(135)
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
		expect(testHarness.persistence.resources.size).toBe(135)
		expect(testHarness.persistence.versions.size).toBe(174)
		expect(testHarness.persistence.receipts).toHaveLength(270)

		const replay = await testHarness.controlPlane.apply({
			runId: staged.runId,
			idempotencyKey: 'apply-failure-key',
		})
		expect(replay).toMatchObject({ state: 'applied', noOp: true })
		expect(testHarness.persistence.resources.size).toBe(135)
		expect(testHarness.persistence.versions.size).toBe(174)
		expect(testHarness.persistence.relations.size).toBe(135)
		expect(testHarness.persistence.receipts).toHaveLength(270)
	})

	it('extracts questions, replays without churn, and blocks detach changes', async () => {
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
		await applyDirectly(testHarness, first.staged.runId, 'apply-quiz-v1')
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
		await expect(
			testHarness.controlPlane.apply({
				runId: second.staged.runId,
				idempotencyKey: 'apply-quiz-v2',
			}),
		).rejects.toMatchObject({
			code: 'LAUNCH_APPLY_POLICY_VIOLATION',
			retryable: false,
		})
		expect(testHarness.persistence.resources.has(questionId)).toBe(true)
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
		await applyDirectly(first, staged.runId, 'apply-v1')

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
