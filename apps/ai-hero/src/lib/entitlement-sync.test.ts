import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	deleted: vi.fn(async () => undefined),
	select: vi.fn(),
	transaction: vi.fn(),
	created: vi.fn(async () => undefined),
	error: vi.fn(async () => undefined),
}))
vi.mock('@/db', () => ({
	db: {
		query: {
			entitlementTypes: {
				findFirst: async () => ({ id: 'cohort-access-type' }),
			},
			organizationMemberships: {
				findFirst: async () => ({ id: 'membership', organizationId: 'org' }),
			},
		},
		select: mocks.select,
		transaction: mocks.transaction,
	},
}))
vi.mock('@/server/logger', () => ({
	log: { info: vi.fn(), error: mocks.error },
}))
vi.mock('./cohorts-query', () => ({ getCohort: vi.fn() }))
vi.mock('./entitlements', () => ({
	EntitlementSourceType: { PURCHASE: 'purchase' },
	createCohortEntitlementInTransaction: mocks.created,
}))

import {
	calculateEntitlementChangesFromIds,
	syncUserCohortEntitlementsWithIds,
} from './entitlement-sync'

function prepareDiff(currentContentIds: string[]) {
	const query = {
		innerJoin: () => query,
		where: () => ({
			then: (resolve: (rows: unknown[]) => unknown) =>
				resolve([{ metadata: { contentIds: currentContentIds } }]),
			limit: async () => [{ id: 'purchase-1' }],
		}),
	}
	mocks.select.mockImplementation(() => ({ from: () => query }))
	mocks.transaction.mockImplementation(
		async (fn: (tx: unknown) => Promise<unknown>) =>
			fn({ delete: () => ({ where: mocks.deleted }) }),
	)
}

beforeEach(() => {
	mocks.deleted.mockClear()
	mocks.created.mockClear()
	mocks.error.mockClear()
})

describe('cohort entitlement live-workshop diff', () => {
	it('revokes a detached workshop and restores it when rollback reattaches it', () => {
		const purchaseEntitlements = [
			{ metadata: { contentIds: ['kept-workshop'] } },
			{ metadata: { contentIds: ['detached-workshop'] } },
		]
		// The cohort reader excludes the deletedAt relation; the workflow passes
		// only the live IDs to the existing per-user diff.
		expect(
			calculateEntitlementChangesFromIds(purchaseEntitlements, [
				'kept-workshop',
			]),
		).toEqual({
			toAdd: [],
			toRemove: ['detached-workshop'],
		})
		expect(
			calculateEntitlementChangesFromIds(
				[{ metadata: { contentIds: ['kept-workshop'] } }],
				['kept-workshop', 'detached-workshop'],
			),
		).toEqual({ toAdd: ['detached-workshop'], toRemove: [] })
	})

	it('executes the revoke for the detached workshop through the existing per-user diff', async () => {
		prepareDiff(['kept-workshop', 'detached-workshop'])
		await expect(
			syncUserCohortEntitlementsWithIds('test-user', 'test-cohort', [
				'kept-workshop',
			]),
		).resolves.toMatchObject({
			toRemove: ['detached-workshop'],
			toAdd: [],
			updated: 1,
		})
		expect(mocks.deleted).toHaveBeenCalledOnce()
	})

	it('course-sync create-only events with boundedRemovals [] grant new workshops but never revoke stale ids', async () => {
		prepareDiff(['kept-workshop', 'stale-workshop'])
		await expect(
			syncUserCohortEntitlementsWithIds(
				'test-user',
				'test-cohort',
				['kept-workshop', 'new-workshop'],
				{
					allowedRemovals: [],
					source: 'course-sync',
					controlPlaneRunId: 'run-create',
				},
			),
		).resolves.toMatchObject({
			toAdd: ['new-workshop'],
			toRemove: [],
			updated: 1,
			refusedRemovals: true,
		})
		expect(mocks.deleted).not.toHaveBeenCalled()
		expect(mocks.created).toHaveBeenCalledOnce()
		expect(mocks.error).toHaveBeenCalledWith(
			'cohort_entitlement_sync.bounded_removal_refused',
			expect.objectContaining({
				cohortId: 'test-cohort',
				affectedUserCount: 1,
				unexpectedIdsCount: 1,
				source: 'course-sync',
				controlPlaneRunId: 'run-create',
			}),
		)
	})

	it('a bounded intentional single detach revokes exactly that workshop', async () => {
		prepareDiff(['kept-workshop', 'detached-workshop'])
		await expect(
			syncUserCohortEntitlementsWithIds(
				'test-user',
				'test-cohort',
				['kept-workshop'],
				{
					allowedRemovals: ['detached-workshop'],
					source: 'course-sync',
					controlPlaneRunId: 'run-detach',
				},
			),
		).resolves.toMatchObject({
			toAdd: [],
			toRemove: ['detached-workshop'],
			updated: 1,
		})
		expect(mocks.deleted).toHaveBeenCalledOnce()
		expect(mocks.created).not.toHaveBeenCalled()
		expect(mocks.error).not.toHaveBeenCalled()
	})

	it('an unexpected revoke is refused for that user while their grants still apply', async () => {
		prepareDiff(['kept-workshop', 'surprise-old'])
		await expect(
			syncUserCohortEntitlementsWithIds(
				'test-user',
				'test-cohort',
				['kept-workshop', 'new-workshop'],
				{
					allowedRemovals: ['planned-detach'],
					source: 'course-sync',
					controlPlaneRunId: 'run-guard',
				},
			),
		).resolves.toMatchObject({
			toAdd: ['new-workshop'],
			toRemove: [],
			updated: 1,
			refusedRemovals: true,
		})
		expect(mocks.deleted).not.toHaveBeenCalled()
		expect(mocks.created).toHaveBeenCalledOnce()
		expect(mocks.error).toHaveBeenCalledWith(
			'cohort_entitlement_sync.bounded_removal_refused',
			expect.objectContaining({
				unexpectedIdsCount: 1,
				affectedUserCount: 1,
				source: 'course-sync',
			}),
		)
	})
})
