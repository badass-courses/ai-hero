import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	purchaseFindFirst: vi.fn(),
	getTeamPurchasesForMember: vi.fn(),
	reconcile: vi.fn(),
	loadPurchase: vi.fn(),
	loadMemberships: vi.fn(),
	commitLink: vi.fn(),
	writeFile: vi.fn(),
}))

vi.mock('@/config', () => ({ default: {} }))
vi.mock('@/db', () => ({
	closeDatabasePool: vi.fn(),
	db: { query: { purchases: { findFirst: mocks.purchaseFindFirst } } },
}))
vi.mock('@/env.mjs', () => ({ env: {} }))
vi.mock('@/lib/team-purchase-fulfillment', () => ({
	drizzleTeamPurchaseFulfillmentDataSource: {
		loadPurchase: mocks.loadPurchase,
		loadMemberships: mocks.loadMemberships,
		commitLink: mocks.commitLink,
	},
	reconcileTeamPurchaseFulfillment: mocks.reconcile,
}))
vi.mock('@/lib/team-purchases', () => ({
	getTeamPurchasesForMember: mocks.getTeamPurchasesForMember,
}))
vi.mock('node:fs/promises', () => ({ writeFile: mocks.writeFile }))

import {
	getRepairExitCode,
	runRepair,
} from './team-purchase-link-repair'

const args = {
	purchaseIds: ['purchase-team'],
	allowWrite: false,
	confirmCount: null,
	receiptPath: '/tmp/team-purchase-repair-test.json',
}

const readback = {
	userId: 'buyer',
	organizationId: 'organization-team',
	purchasedByorganizationMembershipId: 'membership-manager',
	bulkCoupon: {
		organizationId: 'organization-team',
		maxUses: 9,
		usedCount: 7,
	},
}

const linkedResult = {
	status: 'linked',
	purchaseId: 'purchase-team',
	bulkCouponId: 'coupon-team',
	organizationId: 'organization-team',
	organizationMembershipId: 'membership-manager',
}

const linkInput = {
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

describe('team purchase link repair execution', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.purchaseFindFirst.mockResolvedValue(readback)
		mocks.getTeamPurchasesForMember.mockResolvedValue([
			{ id: 'purchase-team' },
		])
	})

	it('plans a link in dry-run mode without calling the production commit function', async () => {
		mocks.reconcile.mockImplementation(
			async (
				_purchaseId: string,
				dataSource: { commitLink: (input: typeof linkInput) => Promise<unknown> },
			) => {
				await dataSource.commitLink(linkInput)
				return {
					status: 'linked',
					purchaseId: 'purchase-team',
					bulkCouponId: 'coupon-team',
					organizationId: 'organization-team',
					organizationMembershipId: 'membership-manager',
				}
			},
		)

		const receipt = await runRepair(args)
		expect(receipt).toMatchObject({
			success: true,
			mode: 'dry-run',
			counts: {
				allowlistedPurchases: 1,
				plannedLinks: 1,
				statuses: { 'planned-link': 1 },
			},
		})
		expect(getRepairExitCode(receipt)).toBe(0)
		expect(mocks.commitLink).not.toHaveBeenCalled()
		expect(mocks.getTeamPurchasesForMember).not.toHaveBeenCalled()
	})

	it('verifies links, team-card visibility, and unchanged seat counts after an approved write', async () => {
		mocks.reconcile.mockResolvedValue({
			status: 'linked',
			purchaseId: 'purchase-team',
			bulkCouponId: 'coupon-team',
			organizationId: 'organization-team',
			organizationMembershipId: 'membership-manager',
		})

		const receipt = await runRepair({
			...args,
			allowWrite: true,
			confirmCount: 1,
		})
		expect(receipt).toMatchObject({
			success: true,
			mode: 'allow-write',
			counts: { verified: 1, verificationFailures: 0 },
		})
		expect(getRepairExitCode(receipt)).toBe(0)
		expect(mocks.purchaseFindFirst).toHaveBeenCalledTimes(2)
		expect(mocks.getTeamPurchasesForMember).toHaveBeenCalledWith('buyer')
	})

	it('fails verification when an approved write changes coupon seat counts', async () => {
		mocks.purchaseFindFirst
			.mockResolvedValueOnce(readback)
			.mockResolvedValueOnce({
				...readback,
				bulkCoupon: { ...readback.bulkCoupon, maxUses: 10 },
			})
		mocks.reconcile.mockResolvedValue({
			status: 'linked',
			purchaseId: 'purchase-team',
			bulkCouponId: 'coupon-team',
			organizationId: 'organization-team',
			organizationMembershipId: 'membership-manager',
		})

		const receipt = await runRepair({
			...args,
			allowWrite: true,
			confirmCount: 1,
		})
		expect(receipt).toMatchObject({
			success: false,
			counts: { verified: 0, verificationFailures: 1 },
		})
		expect(getRepairExitCode(receipt)).toBe(1)
	})

	it.each([
		{ name: 'dry-run', allowWrite: false },
		{ name: 'allow-write', allowWrite: true },
	])('exits nonzero for a missing purchase in $name mode', async ({ allowWrite }) => {
		mocks.purchaseFindFirst.mockResolvedValue(null)

		const receipt = await runRepair({
			...args,
			allowWrite,
			confirmCount: allowWrite ? 1 : null,
		})

		expect(receipt).toMatchObject({
			success: false,
			counts: { unresolved: 1 },
		})
		expect(getRepairExitCode(receipt)).toBe(1)
	})

	it.each([
		{
			name: 'requires-review',
			result: {
				status: 'requires-review',
				purchaseId: 'purchase-team',
				reason: 'manager-role-inactive',
			},
		},
		{
			name: 'skipped',
			result: {
				status: 'skipped',
				purchaseId: 'purchase-team',
				reason: 'not-a-fulfillable-team-purchase',
			},
		},
		{
			name: 'unexpected add-seat',
			result: {
				status: 'add-seat-extension',
				purchaseId: 'purchase-team',
				bulkCouponId: 'coupon-team',
				organizationId: 'organization-team',
				canonicalPurchaseId: 'purchase-original',
			},
		},
	])('exits nonzero for $name in dry-run and allow-write modes', async ({ result }) => {
		for (const allowWrite of [false, true]) {
			vi.clearAllMocks()
			mocks.purchaseFindFirst.mockResolvedValue(readback)
			mocks.reconcile.mockResolvedValue(result)

			const receipt = await runRepair({
				...args,
				allowWrite,
				confirmCount: allowWrite ? 1 : null,
			})

			expect(receipt).toMatchObject({
				success: false,
				counts: { unresolved: 1 },
			})
			expect(getRepairExitCode(receipt)).toBe(1)
		}
	})

	it.each([
		{ name: 'dry-run', allowWrite: false },
		{ name: 'allow-write', allowWrite: true },
	])('exits nonzero for mixed outcomes in $name mode', async ({ allowWrite }) => {
		mocks.reconcile
			.mockResolvedValueOnce(linkedResult)
			.mockResolvedValueOnce({
				status: 'requires-review',
				purchaseId: 'purchase-two',
				reason: 'manager-role-required',
			})

		const receipt = await runRepair({
			...args,
			purchaseIds: ['purchase-team', 'purchase-two'],
			allowWrite,
			confirmCount: allowWrite ? 2 : null,
		})

		expect(receipt).toMatchObject({
			success: false,
			counts: {
				allowlistedPurchases: 2,
				unresolved: 1,
			},
		})
		expect(getRepairExitCode(receipt)).toBe(1)
	})
})
