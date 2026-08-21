import type { CourseJsonDocumentV3 } from '@ai-hero/course-sync-schema'
import { describe, expect, it, vi } from 'vitest'

import {
	COURSE_SYNC_FREEZE_BATCH_SIZE,
	courseSyncFreezeBatches,
	freezeCourseSyncAssetBatch,
} from './freeze-batches'
import type { FrozenSourceAsset } from './types'

const manifest = {
	$schema: 'course.schema.json',
	schemaVersion: 3,
	courseId: 'course-1',
	courseVersionId: 'version-1',
	archiveTTL: '90d',
	sections: [],
} as unknown as CourseJsonDocumentV3

function frozenAsset(sourceVideoId: string): FrozenSourceAsset {
	return {
		sourceVideoId,
		relativePath: `${sourceVideoId}.mp4`,
		providerRevision: `rev-${sourceVideoId}`,
		providerContentHash: null,
		producerSha256: sourceVideoId.padEnd(64, 'a'),
		bytes: 10,
		snapshotUri: null,
		muxAssetId: `mux-${sourceVideoId}`,
		muxPlaybackId: `playback-${sourceVideoId}`,
		duration: 60,
		freezeEffects: { sourceAssetsRead: 1, muxAssetsCreated: 1 },
	}
}

describe('course sync freeze batches', () => {
	it('partitions stable source IDs into batches of at most ten', () => {
		const ids = Array.from({ length: 23 }, (_, index) => `video-${index + 1}`)

		expect(courseSyncFreezeBatches(ids)).toEqual([
			ids.slice(0, 10),
			ids.slice(10, 20),
			ids.slice(20),
		])
		expect(
			courseSyncFreezeBatches(ids).every(
				(batch) => batch.length <= COURSE_SYNC_FREEZE_BATCH_SIZE,
			),
		).toBe(true)
	})

	it('rejects an oversized durable batch before touching an asset', async () => {
		const freezeAsset = vi.fn(async ({ sourceVideoId }) =>
			frozenAsset(sourceVideoId),
		)

		await expect(
			freezeCourseSyncAssetBatch(
				{
					bindingId: 'binding-1',
					manifest,
					batchNumber: 0,
					sourceVideoIds: Array.from(
						{ length: COURSE_SYNC_FREEZE_BATCH_SIZE + 1 },
						(_, index) => `video-${index + 1}`,
					),
				},
				freezeAsset,
			),
		).rejects.toMatchObject({
			code: 'COURSE_SYNC_FREEZE_BATCH_INVALID',
			retryable: false,
		})
		expect(freezeAsset).not.toHaveBeenCalled()
	})

	it('replays a partial batch from durable receipts without duplicate assets', async () => {
		const ids = Array.from({ length: 12 }, (_, index) => `video-${index + 1}`)
		const receipts = new Map<string, FrozenSourceAsset>()
		const muxCreates: string[] = []
		let interrupt = true
		const freezeAsset = vi.fn(async ({ sourceVideoId }) => {
			const receipt = receipts.get(sourceVideoId)
			if (receipt) {
				return {
					...receipt,
					freezeEffects: { sourceAssetsRead: 0, muxAssetsCreated: 0 },
				}
			}
			if (sourceVideoId === 'video-4' && interrupt) {
				interrupt = false
				throw new Error('injected interruption')
			}
			const asset = frozenAsset(sourceVideoId)
			receipts.set(sourceVideoId, asset)
			muxCreates.push(sourceVideoId)
			return asset
		})
		const [firstBatch, secondBatch] = courseSyncFreezeBatches(ids)

		await expect(
			freezeCourseSyncAssetBatch(
				{
					bindingId: 'binding-1',
					manifest,
					batchNumber: 0,
					sourceVideoIds: firstBatch!,
				},
				freezeAsset,
			),
		).rejects.toMatchObject({
			code: 'COURSE_SYNC_INTERNAL_ERROR',
			details: {
				freezeProgress: {
					sourceAssetsRead: 3,
					muxAssetsCreated: 3,
					precision: 'at-least',
				},
			},
		})

		const replayed = await freezeCourseSyncAssetBatch(
			{
				bindingId: 'binding-1',
				manifest,
				batchNumber: 0,
				sourceVideoIds: firstBatch!,
			},
			freezeAsset,
		)
		const continued = await freezeCourseSyncAssetBatch(
			{
				bindingId: 'binding-1',
				manifest,
				batchNumber: 1,
				sourceVideoIds: secondBatch!,
			},
			freezeAsset,
		)

		expect(
			[...replayed.assets, ...continued.assets].map(
				(asset) => asset.sourceVideoId,
			),
		).toEqual(ids)
		expect(receipts.size).toBe(12)
		expect(muxCreates).toEqual(ids)
		expect(new Set(muxCreates).size).toBe(12)
	})
})
