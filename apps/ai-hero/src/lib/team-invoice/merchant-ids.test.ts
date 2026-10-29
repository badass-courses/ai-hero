import { describe, expect, it, vi } from 'vitest'

import { resolveMerchantIds, type MerchantIdsAdapter } from './merchant-ids'

// Mirrors the drizzle adapter: the merchant price lookup only matches a
// merchant product id, never the app's product id.
const adapter = (overrides: Partial<MerchantIdsAdapter> = {}) => {
	const merchantProducts = new Map([
		['product-ma254', { id: 'mproduct_1', identifier: 'prod_x', status: 1 }],
	])
	return {
		getPriceForProduct: vi.fn(async () => ({ id: 'price_app_1' })),
		getMerchantProductForProductId: vi.fn(
			async (productId: string) => merchantProducts.get(productId) ?? null,
		),
		getMerchantPriceForPriceId: vi.fn(
			async (merchantProductId: string, priceId: string) =>
				merchantProductId === 'mproduct_1' && priceId === 'price_app_1'
					? { id: 'mprice_1', identifier: 'price_x', status: 1 }
					: null,
		),
		getMerchantPriceForProductId: vi.fn(async (merchantProductId: string) =>
			merchantProductId === 'mproduct_1'
				? { id: 'mprice_1', identifier: 'price_x', status: 1 }
				: null,
		),
		...overrides,
	} satisfies MerchantIdsAdapter
}

describe('resolveMerchantIds', () => {
	it('finds the Stripe ids from an app product id', async () => {
		expect(await resolveMerchantIds(adapter(), 'product-ma254')).toEqual({
			stripePriceId: 'price_x',
			stripeProductId: 'prod_x',
		})
	})

	it('looks the price up by the merchant product id, not the product id', async () => {
		const a = adapter()
		await resolveMerchantIds(a, 'product-ma254')
		expect(a.getMerchantPriceForPriceId).toHaveBeenCalledWith(
			'mproduct_1',
			'price_app_1',
		)
	})

	it('falls back to the merchant-product lookup without price-id support', async () => {
		const a = adapter({ getMerchantPriceForPriceId: undefined })
		expect(await resolveMerchantIds(a, 'product-ma254')).toEqual({
			stripePriceId: 'price_x',
			stripeProductId: 'prod_x',
		})
	})

	it('returns null when the product has no active merchant product', async () => {
		expect(await resolveMerchantIds(adapter(), 'product-other')).toBeNull()
		const inactive = adapter({
			getMerchantProductForProductId: vi.fn(async () => ({
				id: 'mproduct_1',
				identifier: 'prod_x',
				status: 0,
			})),
		})
		expect(await resolveMerchantIds(inactive, 'product-ma254')).toBeNull()
	})

	it('returns null when there is no app price or no active merchant price', async () => {
		const noPrice = adapter({ getPriceForProduct: vi.fn(async () => null) })
		expect(await resolveMerchantIds(noPrice, 'product-ma254')).toBeNull()
		const inactive = adapter({
			getMerchantPriceForPriceId: vi.fn(async () => ({
				id: 'mprice_1',
				identifier: 'price_x',
				status: 0,
			})),
		})
		expect(await resolveMerchantIds(inactive, 'product-ma254')).toBeNull()
	})
})
