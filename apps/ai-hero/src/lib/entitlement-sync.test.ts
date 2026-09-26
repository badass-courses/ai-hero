import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	deleted: vi.fn(async () => undefined),
	select: vi.fn(),
	transaction: vi.fn(),
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
vi.mock('@/server/logger', () => ({ log: { info: vi.fn(), error: vi.fn() } }))
vi.mock('./cohorts-query', () => ({ getCohort: vi.fn() }))
vi.mock('./entitlements', () => ({
	EntitlementSourceType: { PURCHASE: 'purchase' },
	createCohortEntitlementInTransaction: vi.fn(),
}))

import {
	calculateEntitlementChangesFromIds,
	syncUserCohortEntitlementsWithIds,
} from './entitlement-sync'

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
		mocks.deleted.mockClear()
		const query = {
			innerJoin: () => query,
			where: () => ({
				then: (resolve: (rows: unknown[]) => unknown) =>
					resolve([
						{
							metadata: { contentIds: ['kept-workshop', 'detached-workshop'] },
						},
					]),
				limit: async () => [{ id: 'purchase-1' }],
			}),
		}
		mocks.select.mockImplementation(() => ({ from: () => query }))
		mocks.transaction.mockImplementation(
			async (fn: (tx: unknown) => Promise<unknown>) =>
				fn({
					delete: () => ({ where: mocks.deleted }),
				}),
		)
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
})
