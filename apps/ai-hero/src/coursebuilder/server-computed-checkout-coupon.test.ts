import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ formatPricesForProduct: vi.fn() }))

vi.mock('@coursebuilder/core', () => ({
	formatPricesForProduct: mocks.formatPricesForProduct,
}))

import { resolveServerComputedCheckoutCoupon } from './server-computed-checkout-coupon'

const defaultMerchantCoupon = { id: 'merchant-default', type: 'special' }
const defaultCoupon = {
	id: 'coupon-default',
	merchantCouponId: defaultMerchantCoupon.id,
}
const input = {
	adapter: {
		getDefaultCoupon: vi.fn(async () => ({
			defaultCoupon,
			defaultMerchantCoupon,
		})),
	} as never,
	productId: 'product-crash-course',
	quantity: 5,
	verifiedUserId: 'user-actual',
	country: 'US',
}

describe('resolveServerComputedCheckoutCoupon', () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it.each([
		{ id: 'merchant-server-bulk', type: 'bulk' },
		{ id: 'merchant-server-ppp', type: 'ppp' },
	])('returns a server-selected $type coupon', async (coupon) => {
		mocks.formatPricesForProduct.mockResolvedValue({
			appliedMerchantCoupon: coupon,
		})

		await expect(resolveServerComputedCheckoutCoupon(input)).resolves.toEqual(
			coupon,
		)
		expect(mocks.formatPricesForProduct).toHaveBeenCalledWith(
			expect.objectContaining({
				merchantCouponId: defaultMerchantCoupon.id,
				usedCouponId: defaultCoupon.id,
				productId: input.productId,
				quantity: input.quantity,
				userId: input.verifiedUserId,
			}),
		)
	})

	it('does not turn a server default into a trusted raw selector', async () => {
		mocks.formatPricesForProduct.mockResolvedValue({
			appliedMerchantCoupon: defaultMerchantCoupon,
		})

		await expect(resolveServerComputedCheckoutCoupon(input)).resolves.toBeNull()
	})
})
