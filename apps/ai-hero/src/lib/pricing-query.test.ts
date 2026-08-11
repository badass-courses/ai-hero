import { beforeEach, describe, expect, it, vi } from 'vitest'

import { getPricingData } from './pricing-query'

const mocks = vi.hoisted(() => {
	const selectWhere = vi.fn()
	const selectFrom = vi.fn(() => ({ where: selectWhere }))
	const select = vi.fn(() => ({ from: selectFrom }))
	const getProduct = vi.fn()
	const getPurchase = vi.fn()
	const formatPricesForProduct = vi.fn()
	return {
		select,
		selectFrom,
		selectWhere,
		getProduct,
		getPurchase,
		formatPricesForProduct,
	}
})

vi.mock('@/db', () => ({
	db: { select: mocks.select },
	courseBuilderAdapter: {
		getProduct: mocks.getProduct,
		getPurchase: mocks.getPurchase,
	},
}))

vi.mock('@/server/auth', () => ({
	getServerAuthSession: vi.fn(),
}))

vi.mock('next/headers', () => ({
	headers: vi.fn(),
}))

vi.mock('next/cache', () => ({
	unstable_cache: (fn: unknown) => fn,
}))

vi.mock('@coursebuilder/core', () => ({
	formatPricesForProduct: mocks.formatPricesForProduct,
}))

vi.mock('@coursebuilder/core/pricing/props-for-commerce', () => ({
	propsForCommerce: vi.fn(),
}))

vi.mock('./products-query', () => ({
	getProducts: vi.fn(),
}))

describe('getPricingData quantityAvailable', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.formatPricesForProduct.mockResolvedValue({
			upgradeFromPurchaseId: null,
		})
	})

	it('skips the purchase count query entirely for unlimited products', async () => {
		mocks.getProduct.mockResolvedValue({ quantityAvailable: -1 })

		const result = await getPricingData({ productId: 'product-unlimited' })

		expect(result.quantityAvailable).toBe(-1)
		expect(mocks.select).not.toHaveBeenCalled()
	})

	it('subtracts a SQL count for finite products instead of fetching rows', async () => {
		mocks.getProduct.mockResolvedValue({ quantityAvailable: 40 })
		mocks.selectWhere.mockResolvedValue([{ count: 3 }])

		const result = await getPricingData({ productId: 'product-finite' })

		expect(result.quantityAvailable).toBe(37)
		expect(mocks.select).toHaveBeenCalledTimes(1)
	})

	it('treats a missing count row as zero purchases', async () => {
		mocks.getProduct.mockResolvedValue({ quantityAvailable: 40 })
		mocks.selectWhere.mockResolvedValue([])

		const result = await getPricingData({ productId: 'product-finite' })

		expect(result.quantityAvailable).toBe(40)
	})
})
