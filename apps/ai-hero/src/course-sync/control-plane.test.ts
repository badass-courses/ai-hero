import { createHash } from 'node:crypto'
import { createActor } from 'xstate'
import type { CourseJsonDocumentV3 } from '@ai-hero/course-sync-schema'
import { describe, expect, it } from 'vitest'

import { createCourseSyncControlPlane } from './control-plane'
import { InMemoryCourseSyncPersistence } from './in-memory-persistence'
import { courseSyncRunMachine } from './run-machine'
import {
	AI_HERO_DRAFT_SYNC_BINDING,
	type CourseSyncAssetReader,
	type CourseSyncSnapshotStore,
} from './types'

function bytesFor(videoNumber: number, revision = 'v1') {
	return new TextEncoder().encode(`video-${videoNumber}-${revision}`)
}

function fixture(courseVersionId = 'course-version-v1', changedVideo = 0) {
	let videoNumber = 0
	return {
		$schema: 'course.schema.json',
		schemaVersion: 3 as const,
		courseId: AI_HERO_DRAFT_SYNC_BINDING.sourceCourseId,
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

function stream(bytes: Uint8Array) {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			const split = Math.max(1, Math.floor(bytes.byteLength / 2))
			controller.enqueue(bytes.slice(0, split))
			controller.enqueue(bytes.slice(split))
			controller.close()
		},
	})
}

function harness(
	options: {
		changedVideo?: number
		targetValid?: boolean
		idStart?: number
	} = {},
) {
	const persistence = new InMemoryCourseSyncPersistence()
	persistence.targetValid = options.targetValid ?? true
	let reads = 0
	const assetReader: CourseSyncAssetReader = {
		async read(relativePath) {
			reads += 1
			const match = /video-(\d+)\.mp4$/.exec(relativePath)
			if (!match) throw new Error('bad fixture path')
			const number = Number(match[1])
			const revision = number === options.changedVideo ? 'v2' : 'v1'
			const bytes = bytesFor(number, revision)
			return {
				providerRevision: `dropbox-rev-${number}-${revision}`,
				bytes: bytes.byteLength,
				stream: stream(bytes),
			}
		},
	}
	const snapshots: Array<{ key: string; bytes: number }> = []
	const snapshotStore: CourseSyncSnapshotStore = {
		async putManifest({ key, bytes }) {
			snapshots.push({ key, bytes: bytes.byteLength })
			return `memory://${key}`
		},
		async putAsset({ key, stream: body }) {
			const reader = body.getReader()
			let count = 0
			for (;;) {
				const chunk = await reader.read()
				if (chunk.done) break
				count += chunk.value.byteLength
			}
			snapshots.push({ key, bytes: count })
			return `memory://${key}`
		},
	}
	let id = options.idStart ?? 0
	const controlPlane = createCourseSyncControlPlane({
		persistence,
		assetReader,
		snapshotStore,
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
		bindingId: AI_HERO_DRAFT_SYNC_BINDING.bindingId,
		idempotencyKey: key,
		manifest,
	})
	const previewed = await testHarness.controlPlane.preview(staged.runId)
	return { staged, previewed }
}

describe('draft course sync control plane', () => {
	it('models only the allowed finite lifecycle and has no publish transition', () => {
		const actor = createActor(courseSyncRunMachine).start()
		expect(actor.getSnapshot().value).toBe('staged')
		actor.send({ type: 'PREVIEW' })
		actor.send({ type: 'APPLY' })
		actor.send({ type: 'APPLIED' })
		expect(actor.getSnapshot().value).toBe('applied')
		expect(courseSyncRunMachine.events).not.toContain('PUBLISH')
	})

	it('rejects an invalid target before reading or mutating Dropbox bytes', async () => {
		const testHarness = harness({ targetValid: false })
		await expect(
			testHarness.controlPlane.stage({
				bindingId: AI_HERO_DRAFT_SYNC_BINDING.bindingId,
				idempotencyKey: 'stage-key',
				manifest: fixture(),
			}),
		).rejects.toMatchObject({ code: 'TARGET_ASSERTION_FAILED' })
		expect(testHarness.reads()).toBe(0)
		expect(testHarness.persistence.bindings.size).toBe(0)
		expect(testHarness.persistence.runs.size).toBe(0)
	})

	it('freezes and stream-verifies a baseline v3 revision into one workshop', async () => {
		const testHarness = harness()
		const { staged, previewed } = await stagedAndPreviewed(testHarness)
		expect(staged.state).toBe('staged')
		expect(testHarness.reads()).toBe(16)
		expect(testHarness.snapshots).toHaveLength(17)
		expect(previewed).toMatchObject({
			state: 'previewed',
			resourceCounts: { create: 18, update: 0, retain: 0 },
		})
		const run = testHarness.persistence.runs.get(staged.runId)
		const sections = run?.plan?.resources.filter(
			(item) => item.sourceKind === 'section',
		)
		expect(sections).toHaveLength(2)
		expect(
			sections?.map((item) => [item.parentResourceId, item.position]),
		).toEqual([
			[AI_HERO_DRAFT_SYNC_BINDING.anchorWorkshopId, 0],
			[AI_HERO_DRAFT_SYNC_BINDING.anchorWorkshopId, 1],
		])
		expect(JSON.stringify(previewed)).not.toContain(
			AI_HERO_DRAFT_SYNC_BINDING.productId,
		)
		expect(JSON.stringify(previewed)).not.toContain(
			AI_HERO_DRAFT_SYNC_BINDING.anchorWorkshopId,
		)
	})

	it('accepts a 0.6.0-shaped three-section revision and maps sections by manifest order', async () => {
		const testHarness = harness()
		const { staged, previewed } = await stagedAndPreviewed(
			testHarness,
			fixture060(),
			'stage-0.6.0',
		)
		expect(testHarness.reads()).toBe(34)
		expect(testHarness.snapshots).toHaveLength(35)
		expect(previewed.resourceCounts).toEqual({
			create: 32,
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
			['section-1', AI_HERO_DRAFT_SYNC_BINDING.anchorWorkshopId, 0],
			['section-2', AI_HERO_DRAFT_SYNC_BINDING.anchorWorkshopId, 1],
			['section-3', AI_HERO_DRAFT_SYNC_BINDING.anchorWorkshopId, 2],
		])
	})

	it('rejects an empty section list without reading source videos', async () => {
		const testHarness = harness()
		await expect(
			testHarness.controlPlane.stage({
				bindingId: AI_HERO_DRAFT_SYNC_BINDING.bindingId,
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
		expect(testHarness.persistence.resources.size).toBe(18)
		expect(
			[...testHarness.persistence.resources.values()].every(
				(resource) => resource.currentVersionId !== null,
			),
		).toBe(true)
		expect(testHarness.persistence.receipts).toHaveLength(18)

		const replay = await testHarness.controlPlane.stage({
			bindingId: AI_HERO_DRAFT_SYNC_BINDING.bindingId,
			idempotencyKey: 'another-stage-key',
			manifest: fixture(),
		})
		expect(replay).toMatchObject({ state: 'applied', noOp: true })
		expect(testHarness.reads()).toBe(16)
		expect(testHarness.persistence.versions.size).toBe(18)

		const rollback = await testHarness.controlPlane.rollback({
			runId: staged.runId,
			idempotencyKey: 'rollback-key',
		})
		expect(rollback.state).toBe('rolled_back')
		expect(testHarness.persistence.resources.size).toBe(18)
		expect(testHarness.persistence.versions.size).toBe(36)
		expect(
			[...testHarness.persistence.resources.values()].every(
				(resource) =>
					resource.fields.state === 'draft' &&
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

	it('rolls back the whole mutation transaction when one version write fails', async () => {
		const testHarness = harness()
		const { staged } = await stagedAndPreviewed(testHarness)
		testHarness.persistence.failAfterVersionWrites = 3
		await expect(
			testHarness.controlPlane.apply({
				runId: staged.runId,
				idempotencyKey: 'apply-failure-key',
			}),
		).rejects.toMatchObject({ code: 'INJECTED_APPLY_FAILURE' })
		expect(testHarness.persistence.resources.size).toBe(0)
		expect(testHarness.persistence.versions.size).toBe(0)
		expect(testHarness.persistence.runs.get(staged.runId)?.state).toBe('failed')
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
			update: 1,
			retain: 17,
		})
		const plan = changedReaderHarness.persistence.runs.get(
			second.staged.runId,
		)?.plan
		expect(plan?.media.filter((item) => item.action === 'update')).toHaveLength(
			1,
		)
	})
})
