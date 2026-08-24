import type { SQL } from 'drizzle-orm'
import { MySqlDialect } from 'drizzle-orm/mysql-core'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
	const purchaseFindFirst = vi.fn()
	const purchaseFindMany = vi.fn()
	const couponFindFirst = vi.fn()
	const membershipFindFirst = vi.fn()
	const where = vi.fn()
	const set = vi.fn(() => ({ where }))
	const update = vi.fn(() => ({ set }))
	const execute = vi.fn(async (_query: unknown) => undefined)
	const transactionClient = {
		query: {
			purchases: {
				findFirst: purchaseFindFirst,
				findMany: purchaseFindMany,
			},
			coupon: { findFirst: couponFindFirst },
			organizationMemberships: { findFirst: membershipFindFirst },
		},
		update,
		execute,
	}
	const transaction = vi.fn(
		async (callback: (client: typeof transactionClient) => Promise<unknown>) =>
			callback(transactionClient),
	)

	return {
		purchaseFindFirst,
		purchaseFindMany,
		couponFindFirst,
		membershipFindFirst,
		where,
		set,
		update,
		execute,
		transaction,
	}
})

vi.mock('@/db', () => ({
	db: {
		query: {
			purchases: { findFirst: vi.fn() },
			organizationMemberships: { findMany: vi.fn() },
		},
		transaction: mocks.transaction,
	},
}))

import {
	drizzleTeamPurchaseFulfillmentDataSource,
	teamPurchaseLinkCompareAndSetWhere,
	type TeamPurchaseLinkInput,
} from './team-purchase-fulfillment'

const input: TeamPurchaseLinkInput = {
	purchaseId: 'purchase-team',
	bulkCouponId: 'coupon-team',
	expectedPurchaseStatus: 'Valid',
	expectedPurchaseCreatedAt: new Date('2026-08-19T10:00:00.000Z'),
	expectedPurchaseOrganizationId: null,
	expectedPurchaseMembershipId: null,
	expectedCouponOrganizationId: 'organization-team',
	targetOrganizationId: 'organization-team',
	targetMembershipId: 'membership-manager',
	userId: 'buyer',
}

const purchaseBefore = {
	id: 'purchase-team',
	userId: 'buyer',
	bulkCouponId: 'coupon-team',
	status: 'Valid',
	createdAt: new Date('2026-08-19T10:00:00.000Z'),
	organizationId: null,
	purchasedByorganizationMembershipId: null,
}
const purchaseAfter = {
	...purchaseBefore,
	organizationId: 'organization-team',
	purchasedByorganizationMembershipId: 'membership-manager',
}
const linkedCoupon = {
	id: 'coupon-team',
	organizationId: 'organization-team',
}
const activeManager = {
	id: 'membership-manager',
	userId: 'buyer',
	organizationId: 'organization-team',
	organizationMembershipRoles: [
		{
			active: true,
			deletedAt: null,
			role: {
				name: 'owner',
				active: true,
				deletedAt: null,
			},
		},
	],
}

function arrangeReadback() {
	mocks.purchaseFindFirst
		.mockResolvedValueOnce(purchaseBefore)
		.mockResolvedValueOnce(purchaseAfter)
	mocks.couponFindFirst
		.mockResolvedValueOnce(linkedCoupon)
		.mockResolvedValueOnce(linkedCoupon)
	mocks.purchaseFindMany.mockResolvedValueOnce([purchaseBefore])
	mocks.membershipFindFirst
		.mockResolvedValueOnce(activeManager)
		.mockResolvedValueOnce(activeManager)
}

describe('Drizzle team purchase link transaction', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.where.mockResolvedValue({ rowsAffected: 1 })
	})

	it('renders compare-and-set predicates for buyer, coupon, status, creation time, organization, and membership', () => {
		const condition = teamPurchaseLinkCompareAndSetWhere(input)
		if (!condition) throw new Error('compare-and-set condition missing')
		const query = new MySqlDialect().sqlToQuery(condition.getSQL())

		expect(query.sql).toContain('`AI_Purchase`.`userId` = ?')
		expect(query.sql).toContain('`AI_Purchase`.`bulkCouponId` = ?')
		expect(query.sql).toContain('`AI_Purchase`.`createdAt` = ?')
		expect(query.sql).toContain('`AI_Purchase`.`status` = ?')
		expect(query.sql).toContain('`AI_Purchase`.`organizationId` is null')
		expect(query.sql).toContain(
			'`AI_Purchase`.`organizationMembershipId` is null',
		)
		expect(query.params).toEqual(
			expect.arrayContaining([
				'buyer',
				'coupon-team',
				'Valid',
			]),
		)
	})

	it('links with compare-and-set and verifies the final purchase, coupon, membership, and active manager role', async () => {
		arrangeReadback()

		await expect(
			drizzleTeamPurchaseFulfillmentDataSource.commitLink(input),
		).resolves.toEqual({ status: 'linked' })

		expect(mocks.transaction).toHaveBeenCalledOnce()
		expect(mocks.execute).toHaveBeenCalledTimes(5)
		const dialect = new MySqlDialect()
		const couponLock = dialect.sqlToQuery(
			(mocks.execute.mock.calls[0]![0] as { getSQL: () => SQL }).getSQL(),
		).sql
		const purchaseLock = dialect.sqlToQuery(
			(mocks.execute.mock.calls[1]![0] as { getSQL: () => SQL }).getSQL(),
		).sql
		expect(couponLock).toContain('`AI_Coupon`.`id` = ? FOR UPDATE')
		expect(purchaseLock).toContain('`AI_Purchase`.`id` = ? FOR UPDATE')
		expect(purchaseLock).not.toContain('bulkCouponId')
		expect(mocks.update).toHaveBeenCalledOnce()
		expect(mocks.set).toHaveBeenCalledWith({
			organizationId: 'organization-team',
			purchasedByorganizationMembershipId: 'membership-manager',
		})
		expect(mocks.purchaseFindFirst).toHaveBeenCalledTimes(2)
		expect(mocks.couponFindFirst).toHaveBeenCalledTimes(2)
		expect(mocks.membershipFindFirst).toHaveBeenCalledTimes(2)
	})

	it('returns a typed conflict when the guarded purchase update affects zero rows', async () => {
		mocks.purchaseFindFirst.mockResolvedValueOnce(purchaseBefore)
		mocks.couponFindFirst.mockResolvedValueOnce(linkedCoupon)
		mocks.purchaseFindMany.mockResolvedValueOnce([purchaseBefore])
		mocks.membershipFindFirst.mockResolvedValueOnce(activeManager)
		mocks.where.mockResolvedValueOnce({ rowsAffected: 0 })

		await expect(
			drizzleTeamPurchaseFulfillmentDataSource.commitLink(input),
		).resolves.toEqual({
			status: 'conflict',
			reason: 'concurrent-update',
		})
		expect(mocks.purchaseFindFirst).toHaveBeenCalledOnce()
	})

	it('refuses the link if the manager role became inactive inside the transaction', async () => {
		mocks.purchaseFindFirst.mockResolvedValueOnce(purchaseBefore)
		mocks.couponFindFirst.mockResolvedValueOnce(linkedCoupon)
		mocks.purchaseFindMany.mockResolvedValueOnce([purchaseBefore])
		mocks.membershipFindFirst.mockResolvedValueOnce({
			...activeManager,
			organizationMembershipRoles: [
				{
					...activeManager.organizationMembershipRoles[0],
					active: false,
				},
			],
		})

		await expect(
			drizzleTeamPurchaseFulfillmentDataSource.commitLink(input),
		).resolves.toEqual({
			status: 'conflict',
			reason: 'manager-role-changed',
		})
		expect(mocks.update).not.toHaveBeenCalled()
	})

	it('returns a typed conflict when the purchase buyer changed before the transaction', async () => {
		mocks.purchaseFindFirst.mockResolvedValueOnce({
			...purchaseBefore,
			userId: 'buyer-after-transfer',
		})
		mocks.couponFindFirst.mockResolvedValueOnce(linkedCoupon)
		mocks.purchaseFindMany.mockResolvedValueOnce([
			{ ...purchaseBefore, userId: 'buyer-after-transfer' },
		])

		await expect(
			drizzleTeamPurchaseFulfillmentDataSource.commitLink(input),
		).resolves.toEqual({
			status: 'conflict',
			reason: 'concurrent-update',
		})
		expect(mocks.update).not.toHaveBeenCalled()
	})

	it('keeps the later purchase null when the transaction discovers an earlier sibling', async () => {
		const originalPurchase = {
			...purchaseBefore,
			id: 'purchase-original',
			createdAt: new Date('2026-08-19T09:00:00.000Z'),
		}
		mocks.purchaseFindFirst.mockResolvedValueOnce(purchaseBefore)
		mocks.couponFindFirst.mockResolvedValueOnce(linkedCoupon)
		mocks.purchaseFindMany.mockResolvedValueOnce([
			purchaseBefore,
			originalPurchase,
		])

		await expect(
			drizzleTeamPurchaseFulfillmentDataSource.commitLink(input),
		).resolves.toEqual({
			status: 'add-seat-extension',
			canonicalPurchaseId: 'purchase-original',
			organizationId: 'organization-team',
		})
		expect(mocks.update).not.toHaveBeenCalled()
	})

	it('rolls back with a typed conflict when final readback does not prove the link', async () => {
		mocks.purchaseFindFirst
			.mockResolvedValueOnce(purchaseBefore)
			.mockResolvedValueOnce(purchaseBefore)
		mocks.couponFindFirst
			.mockResolvedValueOnce(linkedCoupon)
			.mockResolvedValueOnce(linkedCoupon)
		mocks.purchaseFindMany.mockResolvedValueOnce([purchaseBefore])
		mocks.membershipFindFirst
			.mockResolvedValueOnce(activeManager)
			.mockResolvedValueOnce(activeManager)

		await expect(
			drizzleTeamPurchaseFulfillmentDataSource.commitLink(input),
		).resolves.toEqual({
			status: 'conflict',
			reason: 'link-readback-failed',
		})
	})
})
