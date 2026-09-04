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
	it('keeps each durable batch to one asset', () => {
		const ids = Array.from({ length: 23 }, (_, index) => `video-${index + 1}`)

		expect(COURSE_SYNC_FREEZE_BATCH_SIZE).toBe(1)
		expect(courseSyncFreezeBatches(ids)).toEqual(ids.map((id) => [id]))
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

	it('replays a completed batch from its receipt without a duplicate asset', async () => {
		const receipts = new Map<string, FrozenSourceAsset>()
		const muxCreates: string[] = []
		const freezeAsset = vi.fn(async ({ sourceVideoId }) => {
			const receipt = receipts.get(sourceVideoId)
			if (receipt) {
				return {
					...receipt,
					freezeEffects: { sourceAssetsRead: 0, muxAssetsCreated: 0 },
				}
			}
			const asset = frozenAsset(sourceVideoId)
			receipts.set(sourceVideoId, asset)
			muxCreates.push(sourceVideoId)
			return asset
		})
		const input = {
			bindingId: 'binding-1',
			manifest,
			batchNumber: 0,
			sourceVideoIds: ['video-1'],
		}

		const created = await freezeCourseSyncAssetBatch(input, freezeAsset)
		const replayed = await freezeCourseSyncAssetBatch(input, freezeAsset)

		expect(created.assets.map((asset) => asset.sourceVideoId)).toEqual([
			'video-1',
		])
		expect(replayed.assets.map((asset) => asset.sourceVideoId)).toEqual([
			'video-1',
		])
		expect(replayed.progress).toEqual({
			sourceAssetsRead: 0,
			muxAssetsCreated: 0,
			precision: 'exact',
		})
		expect(receipts.size).toBe(1)
		expect(muxCreates).toEqual(['video-1'])
	})
})
