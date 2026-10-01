import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/db', () => ({ db: {} }))

import {
	applyMemberlessTeamPurchaseRepair,
	previewMemberlessTeamPurchaseRepair,
	type MemberlessRepairDataSource,
	type MemberlessRepairSnapshot,
} from './team-purchase-memberless-repair'

function snapshot(): MemberlessRepairSnapshot {
	return {
		purchase: {
			id: 'purchase-test',
			userId: 'buyer-test',
			bulkCouponId: 'coupon-test',
			status: 'Valid',
			organizationId: null,
			purchasedByorganizationMembershipId: null,
			createdAt: new Date('2026-09-29T12:00:00Z'),
			country: 'CZ',
			productId: 'product-test',
			merchantChargeId: 'charge-test',
			totalAmount: '399.00',
		},
		coupon: {
			id: 'coupon-test',
			organizationId: null,
			status: 1,
			maxUses: 2,
			usedCount: 0,
		},
		buyer: { id: 'buyer-test', email: 'buyer@example.test' },
		memberships: [],
		personalOrganization: null,
		siblingCount: 0,
	}
}

function source(current = snapshot()) {
	const commit = vi.fn(async () => ({ status: 'repaired' as const }))
	const loadSnapshot = vi.fn(async () => current)
	return { loadSnapshot, commit } satisfies MemberlessRepairDataSource
}

describe('single memberless team purchase repair gates', () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it('previews one genuinely absent personal organization, owner membership and pool link without writes', async () => {
		const ds = source()
		const result = await previewMemberlessTeamPurchaseRepair(
			'purchase-test',
			ds,
		)
		expect(result.status).toBe('ready')
		if (result.status !== 'ready') throw new Error('expected ready preview')
		expect(result.plan).toMatchObject({
			purchaseId: 'purchase-test',
			buyerId: 'buyer-test',
			couponId: 'coupon-test',
			maxUses: 2,
			usedCount: 0,
		})
		expect(ds.commit).not.toHaveBeenCalled()
	})

	it.each([
		{
			name: 'Restricted country purchase',
			mutate: (s: MemberlessRepairSnapshot) => {
				s.purchase!.status = 'Restricted'
			},
		},
		{
			name: 'refunded purchase',
			mutate: (s: MemberlessRepairSnapshot) => {
				s.purchase!.status = 'Refunded'
			},
		},
		{
			name: 'existing ordinary or inactive membership',
			mutate: (s: MemberlessRepairSnapshot) => {
				s.memberships = [{ id: 'existing-member' }]
			},
		},
		{
			name: 'existing personal org without membership',
			mutate: (s: MemberlessRepairSnapshot) => {
				s.personalOrganization = { id: 'existing-org' }
			},
		},
		{
			name: 'add-seat pool or ambiguous owner',
			mutate: (s: MemberlessRepairSnapshot) => {
				s.siblingCount = 1
			},
		},
		{
			name: 'linked coupon',
			mutate: (s: MemberlessRepairSnapshot) => {
				s.coupon!.organizationId = 'other-org'
			},
		},
		{
			name: 'linked purchase',
			mutate: (s: MemberlessRepairSnapshot) => {
				s.purchase!.organizationId = 'other-org'
			},
		},
		{
			name: 'missing buyer',
			mutate: (s: MemberlessRepairSnapshot) => {
				s.buyer = null
			},
		},
	])('holds $name without guessing authority', async ({ mutate }) => {
		const s = snapshot()
		mutate(s)
		const ds = source(s)
		expect(
			(await previewMemberlessTeamPurchaseRepair('purchase-test', ds)).status,
		).toBe('held')
		expect(ds.commit).not.toHaveBeenCalled()
	})

	it('requires explicit write, one exact target, count and approval hash before a transaction', async () => {
		const ds = source()
		const preview = await previewMemberlessTeamPurchaseRepair(
			'purchase-test',
			ds,
		)
		if (preview.status !== 'ready') throw new Error('expected ready')
		for (const overrides of [
			{ allowWrite: false },
			{ confirmCount: 2 },
			{ purchaseId: 'different-purchase' },
			{ approvedPlanHash: '0'.repeat(64) },
		]) {
			await expect(
				applyMemberlessTeamPurchaseRepair(
					preview.plan,
					{
						allowWrite: true,
						confirmCount: 1,
						purchaseId: 'purchase-test',
						approvedPlanHash: preview.plan.approvalHash,
						...overrides,
					},
					ds,
				),
			).rejects.toThrow()
		}
		expect(ds.commit).not.toHaveBeenCalled()
	})

	it('never labels a committed write as verified when independent readback differs', async () => {
		const ds = source()
		const preview = await previewMemberlessTeamPurchaseRepair(
			'purchase-test',
			ds,
		)
		if (preview.status !== 'ready') throw new Error('expected ready')
		const result = await applyMemberlessTeamPurchaseRepair(
			preview.plan,
			{
				allowWrite: true,
				confirmCount: 1,
				purchaseId: 'purchase-test',
				approvedPlanHash: preview.plan.approvalHash,
			},
			ds,
		)
		expect(result).toEqual({
			status: 'verification-failed',
			verified: false,
			writesCommitted: true,
		})
		expect(ds.commit).toHaveBeenCalledTimes(1)
		expect(ds.loadSnapshot).toHaveBeenCalledTimes(2)
	})

	it('binds the target IDs and snapshot to the approval, not merely the purchase count', async () => {
		const ds = source()
		const preview = await previewMemberlessTeamPurchaseRepair(
			'purchase-test',
			ds,
		)
		if (preview.status !== 'ready') throw new Error('expected ready')
		await expect(
			applyMemberlessTeamPurchaseRepair(
				{ ...preview.plan, organizationId: 'tampered-org' },
				{
					allowWrite: true,
					confirmCount: 1,
					purchaseId: 'purchase-test',
					approvedPlanHash: preview.plan.approvalHash,
				},
				ds,
			),
		).rejects.toThrow()
		expect(ds.commit).not.toHaveBeenCalled()
	})
})
