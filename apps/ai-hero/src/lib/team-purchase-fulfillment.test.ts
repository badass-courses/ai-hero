import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
	reconcileTeamPurchaseFulfillment,
	type TeamPurchaseFulfillmentDataSource,
	type TeamPurchaseFulfillmentMembership,
	type TeamPurchaseFulfillmentPurchase,
} from './team-purchase-fulfillment'

function activeRole(name: 'owner' | 'billing_admin' = 'owner') {
	return {
		active: true,
		deletedAt: null,
		role: { name, active: true, deletedAt: null },
	}
}

function membership(
	overrides: Partial<TeamPurchaseFulfillmentMembership> = {},
): TeamPurchaseFulfillmentMembership {
	return {
		id: 'membership-manager',
		organizationId: 'organization-team',
		organizationMembershipRoles: [activeRole()],
		...overrides,
	}
}

function purchase(
	overrides: Partial<TeamPurchaseFulfillmentPurchase> = {},
): TeamPurchaseFulfillmentPurchase {
	return {
		id: 'purchase-team',
		userId: 'buyer',
		createdAt: new Date('2026-08-19T10:00:00.000Z'),
		status: 'Valid',
		bulkCouponId: 'coupon-team',
		organizationId: null,
		purchasedByOrganizationMembershipId: null,
		bulkCouponOrganizationId: null,
		relatedBulkPurchases: [],
		...overrides,
	}
}

function dataSource(input: {
	purchase: TeamPurchaseFulfillmentPurchase
	memberships?: TeamPurchaseFulfillmentMembership[]
	commitResult?: Awaited<
		ReturnType<TeamPurchaseFulfillmentDataSource['commitLink']>
	>
}) {
	let currentPurchase = input.purchase
	const source: TeamPurchaseFulfillmentDataSource = {
		loadPurchase: vi.fn(async () => currentPurchase),
		loadMemberships: vi.fn(async () => input.memberships ?? []),
		commitLink: vi.fn(async (link) => {
			if (input.commitResult) return input.commitResult
			currentPurchase = {
				...currentPurchase,
				organizationId: link.targetOrganizationId,
				purchasedByOrganizationMembershipId: link.targetMembershipId,
				bulkCouponOrganizationId: link.targetOrganizationId,
			}
			return { status: 'linked' as const }
		}),
	}
	return source
}

describe('team purchase fulfillment invariant', () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it('links an initial bulk checkout to the buyer’s sole active managed organization', async () => {
		const source = dataSource({
			purchase: purchase(),
			memberships: [membership()],
		})

		await expect(
			reconcileTeamPurchaseFulfillment('purchase-team', source),
		).resolves.toEqual({
			status: 'linked',
			purchaseId: 'purchase-team',
			bulkCouponId: 'coupon-team',
			organizationId: 'organization-team',
			organizationMembershipId: 'membership-manager',
		})
		expect(source.commitLink).toHaveBeenCalledWith({
			purchaseId: 'purchase-team',
			bulkCouponId: 'coupon-team',
			expectedPurchaseStatus: 'Valid',
			expectedPurchaseCreatedAt: new Date('2026-08-19T10:00:00.000Z'),
			expectedPurchaseOrganizationId: null,
			expectedPurchaseMembershipId: null,
			expectedCouponOrganizationId: null,
			targetOrganizationId: 'organization-team',
			targetMembershipId: 'membership-manager',
			userId: 'buyer',
		})
	})

	it('repairs an invoice purchase from the organization-linked coupon without changing authority', async () => {
		const source = dataSource({
			purchase: purchase({
				bulkCouponOrganizationId: 'organization-team',
			}),
			memberships: [
				membership({
					organizationMembershipRoles: [activeRole('billing_admin')],
				}),
			],
		})

		await expect(
			reconcileTeamPurchaseFulfillment('purchase-team', source),
		).resolves.toMatchObject({
			status: 'linked',
			organizationId: 'organization-team',
		})
		expect(source.commitLink).toHaveBeenCalledWith(
			expect.objectContaining({
				expectedCouponOrganizationId: 'organization-team',
				targetOrganizationId: 'organization-team',
			}),
		)
	})

	it('does not restore intentionally removed roles on retry', async () => {
		const manager = membership()
		const source = dataSource({
			purchase: purchase(),
			memberships: [manager],
		})

		await reconcileTeamPurchaseFulfillment('purchase-team', source)
		manager.organizationMembershipRoles = []

		await expect(
			reconcileTeamPurchaseFulfillment('purchase-team', source),
		).resolves.toMatchObject({ status: 'already-linked' })
		expect(source.commitLink).toHaveBeenCalledTimes(1)
	})

	it('refuses to guess between multiple managed organizations', async () => {
		const source = dataSource({
			purchase: purchase(),
			memberships: [
				membership(),
				membership({
					id: 'membership-other',
					organizationId: 'organization-other',
				}),
			],
		})

		await expect(
			reconcileTeamPurchaseFulfillment('purchase-team', source),
		).resolves.toEqual({
			status: 'requires-review',
			purchaseId: 'purchase-team',
			reason: 'manager-membership-ambiguous',
		})
		expect(source.commitLink).not.toHaveBeenCalled()
	})

	it('does not link an add-seat purchase when the original coupon purchase already owns the team card', async () => {
		const source = dataSource({
			purchase: purchase({
				bulkCouponOrganizationId: 'organization-team',
				relatedBulkPurchases: [
					{
						id: 'purchase-original-team',
						createdAt: new Date('2026-08-19T09:00:00.000Z'),
						organizationId: 'organization-team',
						purchasedByOrganizationMembershipId: 'membership-manager',
					},
				],
			}),
			memberships: [membership()],
		})

		await expect(
			reconcileTeamPurchaseFulfillment('purchase-team', source),
		).resolves.toEqual({
			status: 'add-seat-extension',
			purchaseId: 'purchase-team',
			bulkCouponId: 'coupon-team',
			organizationId: 'organization-team',
			canonicalPurchaseId: 'purchase-original-team',
		})
		expect(source.commitLink).not.toHaveBeenCalled()
	})

	it('keeps an add-seat purchase null when the older original purchase is not linked yet', async () => {
		const source = dataSource({
			purchase: purchase({
				bulkCouponOrganizationId: 'organization-team',
				relatedBulkPurchases: [
					{
						id: 'purchase-original-unlinked',
						createdAt: new Date('2026-08-19T09:00:00.000Z'),
						organizationId: null,
						purchasedByOrganizationMembershipId: null,
					},
				],
			}),
			memberships: [membership()],
		})

		await expect(
			reconcileTeamPurchaseFulfillment('purchase-team', source),
		).resolves.toMatchObject({
			status: 'add-seat-extension',
			canonicalPurchaseId: 'purchase-original-unlinked',
		})
		expect(source.commitLink).not.toHaveBeenCalled()
	})

	it('links the older original purchase when a later unlinked add-seat purchase already exists', async () => {
		const source = dataSource({
			purchase: purchase({
				createdAt: new Date('2026-08-19T09:00:00.000Z'),
				relatedBulkPurchases: [
					{
						id: 'purchase-add-seats',
						createdAt: new Date('2026-08-19T10:00:00.000Z'),
						organizationId: null,
						purchasedByOrganizationMembershipId: null,
					},
				],
			}),
			memberships: [membership()],
		})

		await expect(
			reconcileTeamPurchaseFulfillment('purchase-team', source),
		).resolves.toMatchObject({ status: 'linked' })
		expect(source.commitLink).toHaveBeenCalledOnce()
	})

	it('never promotes an ordinary member when the purchase references their organization', async () => {
		const source = dataSource({
			purchase: purchase({ organizationId: 'organization-team' }),
			memberships: [membership({ organizationMembershipRoles: [] })],
		})

		await expect(
			reconcileTeamPurchaseFulfillment('purchase-team', source),
		).resolves.toEqual({
			status: 'requires-review',
			purchaseId: 'purchase-team',
			reason: 'manager-role-required',
		})
		expect(source.commitLink).not.toHaveBeenCalled()
	})

	it.each([
		{
			name: 'inactive membership role',
			role: { ...activeRole(), active: false },
		},
		{
			name: 'soft-deleted membership role',
			role: { ...activeRole(), deletedAt: new Date('2026-08-01') },
		},
		{
			name: 'inactive role',
			role: { ...activeRole(), role: { ...activeRole().role, active: false } },
		},
		{
			name: 'soft-deleted role',
			role: {
				...activeRole(),
				role: {
					...activeRole().role,
					deletedAt: new Date('2026-08-01'),
				},
			},
		},
	])('refuses $name instead of restoring it', async ({ role }) => {
		const source = dataSource({
			purchase: purchase({
				bulkCouponOrganizationId: 'organization-team',
			}),
			memberships: [
				membership({ organizationMembershipRoles: [role] }),
			],
		})

		await expect(
			reconcileTeamPurchaseFulfillment('purchase-team', source),
		).resolves.toEqual({
			status: 'requires-review',
			purchaseId: 'purchase-team',
			reason: 'manager-role-inactive',
		})
		expect(source.commitLink).not.toHaveBeenCalled()
	})

	it('returns a typed conflict when the compare-and-set loses', async () => {
		const source = dataSource({
			purchase: purchase(),
			memberships: [membership()],
			commitResult: { status: 'conflict', reason: 'concurrent-update' },
		})

		await expect(
			reconcileTeamPurchaseFulfillment('purchase-team', source),
		).resolves.toEqual({
			status: 'requires-review',
			purchaseId: 'purchase-team',
			reason: 'concurrent-update',
		})
	})

	it('refuses conflicting purchase and coupon organizations', async () => {
		const source = dataSource({
			purchase: purchase({
				organizationId: 'organization-a',
				bulkCouponOrganizationId: 'organization-b',
			}),
		})

		await expect(
			reconcileTeamPurchaseFulfillment('purchase-team', source),
		).resolves.toEqual({
			status: 'requires-review',
			purchaseId: 'purchase-team',
			reason: 'organization-conflict',
		})
	})

	it('skips non-bulk purchases', async () => {
		const source = dataSource({
			purchase: purchase({ bulkCouponId: null }),
		})

		await expect(
			reconcileTeamPurchaseFulfillment('purchase-team', source),
		).resolves.toEqual({
			status: 'skipped',
			purchaseId: 'purchase-team',
			reason: 'not-a-fulfillable-team-purchase',
		})
	})
})
