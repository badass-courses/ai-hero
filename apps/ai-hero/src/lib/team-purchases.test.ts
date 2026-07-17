import { describe, expect, it, vi } from 'vitest'

import { getAbility } from '@/ability'

import {
	BILLING_ADMIN_ROLE,
	getTeamPurchasesForMember,
	type TeamPurchaseDataSource,
} from './team-purchases'

type MembershipFixture = Awaited<
	ReturnType<TeamPurchaseDataSource['loadMembershipsForUser']>
>[number]

type PurchaseFixture = Awaited<
	ReturnType<TeamPurchaseDataSource['loadBulkPurchasesForOrganizations']>
>[number]

function membership(
	organizationId: string,
	role: string,
	overrides: Partial<MembershipFixture> = {},
): MembershipFixture {
	return {
		organizationId,
		organizationMembershipRoles: [
		{
			active: true,
			deletedAt: null,
			role: {
				active: true,
				deletedAt: null,
				name: role,
			},
		},
		],
		...overrides,
	}
}

function purchase(
	id: string,
	organizationId: string,
	overrides: Partial<PurchaseFixture> = {},
): PurchaseFixture {
	return {
		id,
		organizationId,
		bulkCouponId: `coupon-${id}`,
		status: 'Valid',
		bulkCoupon: {
			id: `coupon-${id}`,
			maxUses: 10,
			status: 1,
			usedCount: 1,
		},
		...overrides,
	} as PurchaseFixture
}

function dataSource({
	memberships,
	purchases,
}: {
	memberships: MembershipFixture[]
	purchases: PurchaseFixture[]
}): TeamPurchaseDataSource {
	return {
		loadMembershipsForUser: vi.fn(async () => memberships),
		loadBulkPurchasesForOrganizations: vi.fn(async () => purchases),
	}
}

describe('team purchase authorization', () => {
	it("returns only org A's purchases to org A's billing admin", async () => {
		const source = dataSource({
			memberships: [membership('org-a', BILLING_ADMIN_ROLE)],
			// Deliberately return an out-of-scope row to prove the service cannot leak it.
			purchases: [purchase('purchase-a', 'org-a'), purchase('purchase-b', 'org-b')],
		})

		const result = await getTeamPurchasesForMember('admin-a', source)

		expect(result.map(({ id }) => id)).toEqual(['purchase-a'])
		expect(source.loadBulkPurchasesForOrganizations).toHaveBeenCalledWith([
			'org-a',
		])
	})

	it('does not let a seat member manage team purchases', async () => {
		const source = dataSource({
			memberships: [membership('org-a', 'learner')],
			purchases: [purchase('purchase-a', 'org-a')],
		})

		await expect(getTeamPurchasesForMember('member-a', source)).resolves.toEqual(
			[],
		)
		expect(source.loadBulkPurchasesForOrganizations).not.toHaveBeenCalled()
	})

	it('treats an owner as an implicit billing admin', async () => {
		const source = dataSource({
			memberships: [membership('org-a', 'owner')],
			purchases: [purchase('purchase-a', 'org-a')],
		})

		await expect(getTeamPurchasesForMember('owner-a', source)).resolves.toEqual([
			purchase('purchase-a', 'org-a'),
		])
	})

	it('returns nothing to an anonymous or unrelated user', async () => {
		const source = dataSource({
			memberships: [],
			purchases: [purchase('purchase-a', 'org-a')],
		})

		await expect(getTeamPurchasesForMember(null, source)).resolves.toEqual([])
		await expect(getTeamPurchasesForMember('unrelated', source)).resolves.toEqual(
			[],
		)
		expect(source.loadBulkPurchasesForOrganizations).not.toHaveBeenCalled()
	})

	it('ignores inactive or deleted billing-admin grants', async () => {
		const source = dataSource({
			memberships: [
				membership('inactive-membership-role', BILLING_ADMIN_ROLE, {
					organizationMembershipRoles: [
						{
							active: false,
							deletedAt: null,
							role: {
								active: true,
								deletedAt: null,
								name: BILLING_ADMIN_ROLE,
							},
						},
					],
				}),
				membership('deleted-role', BILLING_ADMIN_ROLE, {
					organizationMembershipRoles: [
						{
							active: true,
							deletedAt: null,
							role: {
								active: true,
								deletedAt: new Date('2026-01-01'),
								name: BILLING_ADMIN_ROLE,
							},
						},
					],
				}),
			],
			purchases: [],
		})

		await expect(getTeamPurchasesForMember('former-admin', source)).resolves.toEqual(
			[],
		)
	})
})

describe('billing-admin ability boundary', () => {
	const organizationId = 'org-a'
	const ability = getAbility({
		user: {
			id: 'billing-admin-a',
			role: 'user',
			email: 'billing-admin@example.com',
			fields: {},
			organizationRoles: [
				{ organizationId, name: BILLING_ADMIN_ROLE },
			],
			roles: [],
		},
	})

	it('can manage seats and read billing visibility for its organization', () => {
		expect(ability.can('read', 'Team')).toBe(true)
		expect(ability.can('invite', 'Team')).toBe(true)
		expect(
			ability.can('read', {
				__caslSubjectType__: 'OrganizationBilling',
				organizationId,
			} as any),
		).toBe(true)
	})

	it('does not receive support-only or cross-org powers', () => {
		expect(ability.can('manage', 'all')).toBe(false)
		expect(
			ability.can('read', {
				__caslSubjectType__: 'OrganizationBilling',
				organizationId: 'org-b',
			} as any),
		).toBe(false)
		expect(
			ability.can('update', {
				__caslSubjectType__: 'OrganizationBilling',
				organizationId,
			} as any),
		).toBe(false)
		expect(ability.can('transfer', 'Organization')).toBe(false)
	})
})
