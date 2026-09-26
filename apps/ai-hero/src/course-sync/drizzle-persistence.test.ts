import type { CourseJsonDocumentV3 } from '@ai-hero/course-sync-schema'
import { describe, expect, it, vi } from 'vitest'

import type { SourceRevisionRecord, SyncRunRecord } from './types'

const transaction = vi.hoisted(() => vi.fn())
vi.mock('@/db', () => ({ db: { transaction } }))

import { drizzleCourseSyncPersistence } from './drizzle-persistence'

const now = new Date('2026-09-26T00:00:00.000Z')
const manifest: CourseJsonDocumentV3 = {
	$schema: 'course.schema.json',
	schemaVersion: 4,
	courseId: 'synthetic-course',
	courseVersionId: 'synthetic-version',
	archiveTTL: '90d',
	courseName: 'Placeholder-only cohort',
	sections: [],
}
const revision: SourceRevisionRecord = {
	sourceRevisionId: 'revision-1',
	bindingId: 'binding-1',
	courseVersionId: manifest.courseVersionId,
	providerRevision: 'provider-1',
	manifestSha256: 'hash',
	manifestSnapshotUri: null,
	manifest,
	assets: [],
	stagedAt: now,
}
const run: SyncRunRecord = {
	runId: 'run-1',
	bindingId: revision.bindingId,
	sourceRevisionId: revision.sourceRevisionId,
	courseVersionId: revision.courseVersionId,
	state: 'staged',
	stageIdempotencyKey: 'stage-key',
	stageFingerprint: 'fingerprint',
	applyIdempotencyKey: null,
	rollbackOfRunId: null,
	compensatingRunId: null,
	plan: null,
	planSha256: null,
	failureCode: null,
	failureReason: null,
	createdAt: now,
	updatedAt: now,
}

describe('drizzle course-sync staging', () => {
	it.each([0, 1])('inserts revision and run with %i frozen assets', async (assetCount) => {
		const inserts: unknown[] = []
		transaction.mockImplementation(async (callback) =>
			callback({
				select: () => ({
					from: () => ({ where: () => ({ for: async () => [] }) }),
				}),
				insert: (table: unknown) => ({
					values: async (values: unknown) => {
						// Match Drizzle's MySQL insert contract, not the in-memory persistence.
						if (Array.isArray(values) && values.length === 0) {
							throw new Error('values() must be called with at least one value')
						}
						inserts.push(table)
					},
				}),
			}),
		)

		const assets = Array.from({ length: assetCount }, () => ({
			sourceVideoId: 'video-1',
			relativePath: 'video.mp4',
			providerRevision: 'provider-1',
			providerContentHash: null,
			producerSha256: 'asset-hash',
			bytes: 1,
			snapshotUri: null,
			muxAssetId: null,
			muxPlaybackId: null,
			duration: null,
		}))
		await expect(
			drizzleCourseSyncPersistence.createStaged({
				revision: { ...revision, assets },
				run,
			}),
		).resolves.toBe(run)
		expect(inserts).toHaveLength(assetCount + 2)
	})
})
