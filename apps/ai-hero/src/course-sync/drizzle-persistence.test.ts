import type { CourseJsonDocumentV3 } from '@ai-hero/course-sync-schema'
import { describe, expect, it, vi } from 'vitest'

import type { ResourcePlanItem, SourceRevisionRecord, SyncPlan, SyncRunRecord } from './types'
import { syntheticCohortBinding as binding } from './test-fixtures/cohort-binding'
import { sha256, stableJson } from './control-plane'
import { courseSyncSourceFields } from './resource-fields'
import { contentResource, contentResourceVersion } from '@/db/schema'

const transaction = vi.hoisted(() => vi.fn())
const findRun = vi.hoisted(() => vi.fn())
vi.mock('@/db', () => ({ db: { transaction, query: { courseSyncRun: { findFirst: findRun } } } }))
vi.mock('./types', async (importOriginal) => ({
	...await importOriginal<typeof import('./types')>(),
	getServerCourseSyncBinding: () => binding,
}))

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

describe('drizzle course-sync operator fields', () => {
	it.each(['update', 'retain', 'create'] as const)(
		'%s uses locked operator fields, not scheduling values from preview',
		async (action) => {
			const sourceFields = {
				title: 'New source title', slug: 'section-1', state: 'draft', visibility: 'unlisted',
				courseSync: { bindingId: binding.bindingId, sourceSectionId: 'section-1' },
			}
			const previousFields = { ...sourceFields, title: action === 'update' ? 'Old title' : sourceFields.title }
			const schedule = { startsAt: '2026-12-09T08:01:00.000Z', endsAt: null, timezone: 'America/Los_Angeles', releasePolicy: { mode: 'scheduled' } }
			const existing = { id: 'workshop-1', type: 'workshop', currentVersionId: 'version-before', fields: { ...previousFields, ...schedule } }
			const item: ResourcePlanItem = {
				sourceKind: 'workshop', sourceId: 'section-1', targetResourceId: existing.id,
				parentResourceId: binding.anchorCohortId, position: 0, detached: false, previousDetached: false,
				previousParentResourceId: action === 'create' ? null : binding.anchorCohortId,
				previousPosition: action === 'create' ? null : 0,
				action, fields: sourceFields,
				previousVersionId: action === 'create' ? null : existing.currentVersionId,
				previousFieldsSha256: action === 'create' ? null : sha256(stableJson(courseSyncSourceFields('workshop', previousFields))),
			}
			const input = { bindingId: binding.bindingId, sourceRevisionId: revision.sourceRevisionId, courseVersionId: revision.courseVersionId, resources: [item], media: [] }
			const plan: SyncPlan = { ...input, planSha256: sha256(stableJson(input)) }
			const previewed = { ...run, ...input, state: 'previewed', plan, planSha256: plan.planSha256 }
			const relation = { resourceOfId: binding.anchorCohortId, resourceId: existing.id, position: 0, deletedAt: null, metadata: { bindingId: binding.bindingId } }
			const versions: Array<Record<string, unknown>> = []
			const promotions: Array<Record<string, unknown>> = []
			const selectRows: Array<() => unknown[]> = [
				() => [{ binding }],
				() => [previewed],
				() => [{ ...revision, bindingId: binding.bindingId }],
				() => [{ runId: run.runId }],
				() => [{ controlPlaneRunId: run.runId, courseVersionId: plan.courseVersionId, providerRevision: revision.providerRevision, status: 'awaiting-apply' }],
				() => [{ id: binding.productId, type: 'cohort', fields: { state: 'draft', visibility: 'unlisted' } }],
				() => [{ id: binding.anchorCohortId, type: 'cohort', fields: { state: 'draft', visibility: 'unlisted' }, deletedAt: null }],
				() => [{ productId: binding.productId, position: 0 }],
				() => action === 'create' ? [] : [{ position: 0, resourceId: existing.id, resourceType: existing.type, resourceFields: existing.fields }],
				() => [], // no prior receipts
				() => action === 'create' ? [] : [existing],
				() => action === 'create' ? [] : [relation],
				() => action === 'create' ? [] : [{ resourceId: existing.id, versionNumber: 1 }],
				() => [{ id: existing.id }], // prepared resources
				...(action === 'retain' ? [] : [() => versions.map(({ id }) => ({ id }))]),
				() => [{ resourceId: existing.id }], // prepared receipts
				() => action === 'retain' ? [existing] : promotions,
				() => [relation],
			]
			let queryIndex = 0
			transaction.mockImplementation(async (callback) => callback({
				select: () => {
					const rows = selectRows[queryIndex++]?.()
					if (!rows) throw new Error(`unexpected select ${queryIndex}`)
					const promise = Promise.resolve(rows)
					const query = { from: vi.fn(), where: vi.fn(), leftJoin: vi.fn(), for: vi.fn(async () => rows), then: promise.then.bind(promise) }
					query.from.mockReturnValue(query)
					query.where.mockReturnValue(query)
					query.leftJoin.mockReturnValue(query)
					return query
				},
				insert: (table: unknown) => ({ values: (rows: Array<Record<string, unknown>>) => {
					if (table === contentResourceVersion) versions.push(...rows)
					return { onDuplicateKeyUpdate: async () => {
						if (table === contentResource) promotions.push(...rows)
					} }
				} }),
				update: () => ({ set: () => ({ where: async () => undefined }) }),
			}))
			findRun.mockResolvedValue({ ...previewed, state: 'applied' })
			await expect(drizzleCourseSyncPersistence.applyAtomically({ runId: run.runId, plan, idempotencyKey: 'apply-key', createdById: 'test-writer' })).resolves.toMatchObject({ state: 'applied' })
			expect(queryIndex).toBe(selectRows.length)
			if (action === 'retain') {
				expect(versions).toEqual([])
				expect(promotions).toEqual([])
			} else {
				const expectedFields = action === 'create' ? sourceFields : { ...sourceFields, ...schedule }
				expect(versions[0]?.fields).toEqual(expectedFields)
				expect(promotions[0]?.fields).toEqual(expectedFields)
				expect(versions[0]?.id).toBe(`version~${sha256(stableJson({ runId: run.runId, resourceId: existing.id, fields: expectedFields }))}`)
			}
		},
	)
})
