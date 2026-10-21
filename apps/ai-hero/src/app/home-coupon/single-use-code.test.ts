import { describe, expect, it } from 'vitest'

import { getCouponForCode } from '@coursebuilder/commerce/props-for-commerce'

import { shouldRenderClaimPanel } from '@/components/evergreen-claim-panel'

// The shape of the single-use crash-course codes: created directly in the
// database, no merchant coupon, no expiry, restricted to the workshop product.
const singleUseCode = {
	id: 'xero_ABCDEFGHIJKLMN',
	code: null,
	createdAt: new Date('2026-10-01T00:00:00Z'),
	expires: null,
	fields: {},
	maxUses: 1,
	usedCount: 0,
	default: false,
	merchantCouponId: null,
	status: 1,
	percentageDiscount: 1,
	restrictedToProductId: 'product-ma254',
	amountDiscount: null,
	bulkPurchaseId: null,
	organizationId: null,
}

const adapter = (row: typeof singleUseCode) =>
	({ getCoupon: async () => row }) as any

describe('single-use 100% code with no merchant coupon', () => {
	it('is valid and redeemable on the home page lookup (no product list)', async () => {
		const coupon = await getCouponForCode(
			singleUseCode.id,
			[],
			adapter(singleUseCode),
		)
		expect(coupon).toMatchObject({ isValid: true, isRedeemable: true })
	})

	it('never shows the "cannot confirm an offer" panel to a visitor with no evergreen offer', () => {
		expect(
			shouldRenderClaimPanel({
				pilotOnly: true,
				phase: 'displaying',
				status: 'unavailable',
			}),
		).toBe(false)
	})
})
