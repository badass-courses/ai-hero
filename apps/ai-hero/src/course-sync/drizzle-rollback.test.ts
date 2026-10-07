import { describe, expect, it, vi } from 'vitest'

import {
	contentResource,
	contentResourceResource,
	contentResourceVersion,
} from '@/db/schema'
import { sha256, stableJson } from './control-plane'
import { syntheticCohortBinding as binding } from './test-fixtures/cohort-binding'
import type { ResourcePlanItem, SyncPlan, SyncRunRecord } from './types'

const transaction = vi.hoisted(() => vi.fn())
const findRun = vi.hoisted(() => vi.fn())
vi.mock('@/db', () => ({
	db: { transaction, query: { courseSyncRun: { findFirst: findRun } } },
}))
import { drizzleCourseSyncPersistence } from './drizzle-persistence'

function rollbackHarness(
	drift:
		| 'none'
		| 'updated-title'
		| 'updated-pointer'
		| 'updated-relation'
		| 'retained-title',
) {
	const sourceFields = {
		title: 'Applied title',
		slug: 'workshop',
		state: 'draft',
		visibility: 'unlisted',
		courseSync: { bindingId: binding.bindingId },
	}
	const schedule = {
		startsAt: '2026-12-09T08:01:00.000Z',
		endsAt: null,
		timezone: 'America/Los_Angeles',
	}
	const item = (
		id: string,
		action: 'retain' | 'update',
		position: number,
	): ResourcePlanItem => ({
		sourceKind: 'workshop',
		sourceId: id,
		targetResourceId: id,
		parentResourceId: binding.anchorCohortId,
		position,
		detached: false,
		previousDetached: false,
		previousParentResourceId: binding.anchorCohortId,
		previousPosition: position,
		action,
		fields: sourceFields,
		previousVersionId: `${id}-parent`,
		previousFieldsSha256: null,
	})
	const input = {
		bindingId: binding.bindingId,
		sourceRevisionId: 'revision-1',
		courseVersionId: 'version-1',
		resources: [item('retained', 'retain', 0), item('updated', 'update', 1)],
		media: [],
	}
	const plan: SyncPlan = { ...input, planSha256: sha256(stableJson(input)) }
	const now = new Date('2026-10-07T00:00:00.000Z')
	const original: SyncRunRecord = {
		...input,
		runId: 'applied-run',
		state: 'applied',
		stageIdempotencyKey: 'stage-key',
		stageFingerprint: 'fingerprint',
		applyIdempotencyKey: 'apply-key',
		rollbackOfRunId: null,
		compensatingRunId: null,
		plan,
		planSha256: plan.planSha256,
		failureCode: null,
		failureReason: null,
		createdAt: now,
		updatedAt: now,
	}
	const resources = plan.resources.map((resource) => ({
		id: resource.targetResourceId,
		type: 'workshop',
		createdById: 'test-writer',
		currentVersionId: `${resource.targetResourceId}-applied`,
		fields: { ...sourceFields, ...schedule },
	}))
	const relations = plan.resources.map((resource) => ({
		resourceId: resource.targetResourceId,
		resourceOfId: binding.anchorCohortId,
		position: resource.position,
		deletedAt: null,
		metadata: { bindingId: binding.bindingId },
	}))
	const receipts = plan.resources.map((resource) => ({
		runId: original.runId,
		resourceId: resource.targetResourceId,
		contentResourceVersionId: `${resource.targetResourceId}-applied`,
		parentVersionId: `${resource.targetResourceId}-parent`,
		previousParentResourceId: binding.anchorCohortId,
		previousPosition: resource.position,
		action: resource.action,
	}))
	const lockedVersions = [
		// A retain receipt still points at a version from before PUT added scheduling.
		{
			id: 'retained-applied',
			resourceId: 'retained',
			versionNumber: 1,
			fields: sourceFields,
		},
		// The update's operator schedule has changed since apply, without a pointer change.
		{
			id: 'updated-applied',
			resourceId: 'updated',
			versionNumber: 2,
			fields: {
				...sourceFields,
				startsAt: '2026-11-09T08:01:00.000Z',
				timezone: 'UTC',
			},
		},
		{
			id: 'updated-parent',
			resourceId: 'updated',
			versionNumber: 1,
			fields: {
				...sourceFields,
				title: 'Before',
				startsAt: '2026-10-01T00:00:00.000Z',
			},
		},
	]
	if (drift === 'updated-title')
		resources[1]!.fields.title = 'Unexpected source edit'
	if (drift === 'updated-pointer')
		resources[1]!.currentVersionId = 'manual-version'
	if (drift === 'updated-relation') relations[1]!.position = 9
	if (drift === 'retained-title')
		resources[0]!.fields.title = 'Retained operator edit'
	const versions: Array<Record<string, unknown>> = []
	const restorations: Array<Record<string, unknown>> = []
	const promotions: Array<Record<string, unknown>> = []
	const selects: Array<() => unknown[]> = [
		() => [{ bindingId: binding.bindingId, binding }],
		() => [original],
		() => [{ runId: original.runId }],
		() => receipts,
		() => resources,
		() => relations,
		() => lockedVersions,
		() => versions.map(({ id }) => ({ id })),
		() => [{ resourceId: 'updated' }],
		() => restorations,
		() => promotions,
	]
	let queryIndex = 0
	const insert = vi.fn((table: unknown) => ({
		values: (
			rows: Record<string, unknown> | Array<Record<string, unknown>>,
		) => {
			const values = Array.isArray(rows) ? rows : [rows]
			if (table === contentResourceVersion) versions.push(...values)
			return {
				onDuplicateKeyUpdate: async () => {
					if (table === contentResource) promotions.push(...values)
					if (table === contentResourceResource) restorations.push(...values)
				},
			}
		},
	}))
	transaction.mockImplementation(async (callback) =>
		callback({
			select: () => {
				const rows = selects[queryIndex++]?.()
				if (!rows) throw new Error(`unexpected select ${queryIndex}`)
				const promise = Promise.resolve(rows)
				const query = {
					from: vi.fn(),
					where: vi.fn(),
					orderBy: vi.fn(),
					limit: vi.fn(),
					for: vi.fn(async () => rows),
					then: promise.then.bind(promise),
				}
				for (const method of [
					query.from,
					query.where,
					query.orderBy,
					query.limit,
				])
					method.mockReturnValue(query)
				return query
			},
			insert,
			update: () => ({ set: () => ({ where: async () => undefined }) }),
		}),
	)
	findRun.mockResolvedValue({ ...original, state: 'rolled_back' })
	const rollback = () =>
		drizzleCourseSyncPersistence.rollbackAtomically({
			runId: original.runId,
			bindingId: binding.bindingId,
			idempotencyKey: 'rollback-key',
			compensatingRunId: 'compensating-run',
			createdById: 'test-writer',
		})
	return {
		rollback,
		insert,
		versions,
		promotions,
		resources,
		schedule,
		queryCount: () => queryIndex,
		expectedQueryCount: selects.length,
	}
}

describe('Drizzle rollback field ownership', () => {
	it.each(['none', 'retained-title'] as const)(
		'keeps scheduling through the real rollback path (%s)',
		async (drift) => {
			const test = rollbackHarness(drift)
			await expect(test.rollback()).resolves.toMatchObject({
				state: 'rolled_back',
			})
			expect(test.queryCount()).toBe(test.expectedQueryCount)
			expect(test.versions).toHaveLength(1)
			expect(test.promotions).toHaveLength(1)
			const expected = { ...test.resources[1]!.fields, title: 'Before' }
			expect(test.versions[0]?.fields).toEqual(expected)
			expect(test.promotions[0]?.fields).toEqual(expected)
			expect(test.versions[0]?.fields).toMatchObject(test.schedule)
			expect(test.promotions[0]?.id).toBe('updated')
			expect(test.resources[0]!.fields).toMatchObject(test.schedule)
		},
	)

	it.each(['updated-title', 'updated-pointer', 'updated-relation'] as const)(
		'rejects %s drift before any compensating write',
		async (drift) => {
			const test = rollbackHarness(drift)
			await expect(test.rollback()).rejects.toMatchObject({
				code: 'ROLLBACK_TARGET_CHANGED',
			})
			expect(test.insert).not.toHaveBeenCalled()
			expect(test.versions).toEqual([])
			expect(test.promotions).toEqual([])
		},
	)
})
