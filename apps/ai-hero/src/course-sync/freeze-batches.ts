import type { CourseJsonDocumentV3 } from '@ai-hero/course-sync-schema'

import { CourseSyncError, asCourseSyncError } from './errors'
import type { FrozenSourceAsset } from './types'

export const COURSE_SYNC_FREEZE_BATCH_SIZE = 10

export type CourseSyncFreezeBatchInput = {
	bindingId: string
	manifest: CourseJsonDocumentV3
	batchNumber: number
	sourceVideoIds: ReadonlyArray<string>
}

export type CourseSyncFreezeProgress = {
	sourceAssetsRead: number
	muxAssetsCreated: number
	precision: 'exact' | 'at-least' | 'unknown'
}

export type CourseSyncFrozenAssetBatch = {
	assets: ReadonlyArray<FrozenSourceAsset>
	progress: CourseSyncFreezeProgress
}

export type FreezeCourseSyncAsset = (input: {
	bindingId: string
	manifest: CourseJsonDocumentV3
	sourceVideoId: string
}) => Promise<FrozenSourceAsset>

export function courseSyncFreezeBatches(
	sourceVideoIds: ReadonlyArray<string>,
): ReadonlyArray<ReadonlyArray<string>> {
	const batches: string[][] = []
	for (
		let cursor = 0;
		cursor < sourceVideoIds.length;
		cursor += COURSE_SYNC_FREEZE_BATCH_SIZE
	) {
		batches.push(
			sourceVideoIds.slice(cursor, cursor + COURSE_SYNC_FREEZE_BATCH_SIZE),
		)
	}
	return batches
}

function freezeProgress(assets: ReadonlyArray<FrozenSourceAsset>) {
	let sourceAssetsRead = 0
	let muxAssetsCreated = 0
	let precision: CourseSyncFreezeProgress['precision'] = 'exact'
	for (const asset of assets) {
		if (!asset.freezeEffects) {
			precision = 'unknown'
			continue
		}
		sourceAssetsRead += asset.freezeEffects.sourceAssetsRead
		muxAssetsCreated += asset.freezeEffects.muxAssetsCreated
	}
	return { sourceAssetsRead, muxAssetsCreated, precision }
}

export async function freezeCourseSyncAssetBatch(
	input: CourseSyncFreezeBatchInput,
	freezeAsset: FreezeCourseSyncAsset,
): Promise<CourseSyncFrozenAssetBatch> {
	if (
		input.sourceVideoIds.length === 0 ||
		input.sourceVideoIds.length > COURSE_SYNC_FREEZE_BATCH_SIZE ||
		new Set(input.sourceVideoIds).size !== input.sourceVideoIds.length
	) {
		throw new CourseSyncError(
			'COURSE_SYNC_FREEZE_BATCH_INVALID',
			`Freeze batch ${input.batchNumber} must contain 1-${COURSE_SYNC_FREEZE_BATCH_SIZE} unique source video IDs.`,
			500,
			{ category: 'internal', retryable: false },
		)
	}

	const assets: FrozenSourceAsset[] = []
	try {
		for (const sourceVideoId of input.sourceVideoIds) {
			assets.push(
				await freezeAsset({
					bindingId: input.bindingId,
					manifest: input.manifest,
					sourceVideoId,
				}),
			)
		}
	} catch (error) {
		const failure = asCourseSyncError(error)
		const progress = freezeProgress(assets)
		throw new CourseSyncError(failure.code, failure.message, failure.status, {
			category: failure.category,
			retryable: failure.retryable,
			details: {
				...failure.details,
				batchNumber: input.batchNumber,
				freezeProgress: {
					...progress,
					precision:
						progress.precision === 'unknown' ? 'unknown' : 'at-least',
				},
			},
		})
	}

	return { assets, progress: freezeProgress(assets) }
}
