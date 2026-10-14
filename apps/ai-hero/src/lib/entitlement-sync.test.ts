import type { SQL } from 'drizzle-orm'
import { MySqlDialect } from 'drizzle-orm/mysql-core'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	deleted: vi.fn(async () => undefined),
	select: vi.fn(),
	transaction: vi.fn(),
	created: vi.fn(async (_tx: unknown, _params: { metadata?: Record<string, unknown> }) => undefined),
	error: vi.fn(async () => undefined),
	membership: vi.fn(
		async (_query: { where?: SQL }): Promise<
			{ id: string; organizationId: string } | undefined
		> => ({ id: 'membership', organizationId: 'org' }),
	),
}))
vi.mock('@/db', () => ({
	db: {
		query: {
			entitlementTypes: {
				findFirst: async () => ({ id: 'cohort-access-type' }),
			},
			organizationMemberships: {
				findFirst: mocks.membership,
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

function prepareDiff(
	currentContentIds: string[],
	fields: Record<string, unknown> = {},
	purchaseRows?: Array<{
		id: string
		fields: Record<string, unknown>
		organizationId?: string
	}>,
) {
	mocks.select.mockImplementation((selection: Record<string, unknown>) => {
		const query = {
			innerJoin: () => query,
			where: async () => selection.fields
				? purchaseRows ?? [{ id: 'purchase-1', fields }]
				: [{ metadata: { contentIds: currentContentIds } }],
		}
		return { from: () => query }
	})
	mocks.transaction.mockImplementation(
		async (fn: (tx: unknown) => Promise<unknown>) =>
			fn({ delete: () => ({ where: mocks.deleted }) }),
	)
}

beforeEach(() => {
	mocks.deleted.mockClear()
	mocks.created.mockClear()
	mocks.error.mockClear()
	mocks.membership.mockReset()
	mocks.membership.mockResolvedValue({ id: 'membership', organizationId: 'org' })
})

describe('cohort entitlement live-workshop diff', () => {
	it('falls back to the first user membership when the purchase organization has no membership', async () => {
		prepareDiff(['old-workshop'], {}, [{
			id: 'purchase-1',
			fields: { source: 'comp', earlyAccess: true },
			organizationId: 'purchase-org',
		}])
		mocks.membership.mockResolvedValueOnce(undefined)
		mocks.membership.mockResolvedValueOnce({
			id: 'fallback-member', organizationId: 'fallback-org',
		})
		await expect(
			syncUserCohortEntitlementsWithIds('test-user', 'test-cohort', [
				'old-workshop', 'new-workshop',
			]),
		).resolves.toMatchObject({ updated: 1 })
		const dialect = new MySqlDialect()
		expect(mocks.membership).toHaveBeenCalledTimes(2)
		expect(
			dialect.sqlToQuery(mocks.membership.mock.calls[0]![0].where!).params,
		).toEqual(['test-user', 'purchase-org'])
		expect(
			dialect.sqlToQuery(mocks.membership.mock.calls[1]![0].where!).params,
		).toEqual(['test-user'])
		expect(mocks.created).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				organizationId: 'fallback-org',
				organizationMembershipId: 'fallback-member',
				metadata: { contentIds: ['new-workshop'], earlyAccess: true },
			}),
		)
	})

	it('keeps the purchase organization membership when it exists', async () => {
		prepareDiff(['old-workshop'], {}, [{
			id: 'purchase-1', fields: {}, organizationId: 'purchase-org',
		}])
		mocks.membership.mockResolvedValueOnce({
			id: 'scoped-member', organizationId: 'purchase-org',
		})
		await syncUserCohortEntitlementsWithIds('test-user', 'test-cohort', [
			'old-workshop', 'new-workshop',
		])
		expect(mocks.membership).toHaveBeenCalledOnce()
		expect(mocks.created).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				organizationId: 'purchase-org',
				organizationMembershipId: 'scoped-member',
			}),
		)
	})

	it.each([
		[{ source: 'comp', earlyAccess: true }, true],
		[{ source: 'comp', earlyAccess: 'true' }, undefined],
		[{ source: 'comp', earlyAccess: false }, undefined],
		[{}, undefined],
		[{ source: 'other', earlyAccess: true }, undefined],
	] as const)('preserves strict comp early access for workshops added later (%j)', async (fields, expected) => {
		prepareDiff(['old-workshop'], fields)
		await syncUserCohortEntitlementsWithIds('test-user', 'test-cohort', ['old-workshop', 'new-workshop'])
		expect(mocks.created).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
			resourceId: 'new-workshop', sourceId: 'purchase-1',
			metadata: expect.objectContaining({ contentIds: ['new-workshop'] }),
		}))
		expect(mocks.created.mock.calls[0]?.[1]?.metadata?.earlyAccess).toBe(expected)
	})
	it('uses the active comp when another product purchase also links the cohort', async () => {
		prepareDiff(['old-workshop'], {}, [
			{ id: 'ordinary-purchase', fields: {} },
			{ id: 'comp-purchase', fields: { source: 'comp', earlyAccess: true } },
		])
		await syncUserCohortEntitlementsWithIds('test-user', 'test-cohort', ['old-workshop', 'new-workshop'])
		expect(mocks.created).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
			sourceId: 'comp-purchase', metadata: { contentIds: ['new-workshop'], earlyAccess: true },
		}))
	})

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
