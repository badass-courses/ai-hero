import { beforeEach, describe, expect, it, vi } from 'vitest'

import { getPricingData } from './pricing-query'

const mocks = vi.hoisted(() => {
	const getSeatsTaken = vi.fn()
	const getProduct = vi.fn()
	const getPurchase = vi.fn()
	const formatPricesForProduct = vi.fn()
	return {
		getSeatsTaken,
		getProduct,
		getPurchase,
		formatPricesForProduct,
	}
})

vi.mock('./seats-taken-query', async (importActual) => ({
	...(await importActual<typeof import('./seats-taken-query')>()),
	getSeatsTaken: mocks.getSeatsTaken,
}))

vi.mock('@/db', () => ({
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

vi.mock('@coursebuilder/commerce', () => ({
	formatPricesForProduct: mocks.formatPricesForProduct,
}))

vi.mock('@coursebuilder/commerce/props-for-commerce', () => ({
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
		expect(mocks.getSeatsTaken).not.toHaveBeenCalled()
	})

	it('subtracts the seats taken for finite products', async () => {
		mocks.getProduct.mockResolvedValue({ quantityAvailable: 40 })
		mocks.getSeatsTaken.mockResolvedValue(3)

		const result = await getPricingData({ productId: 'product-finite' })

		expect(result.quantityAvailable).toBe(37)
		expect(mocks.getSeatsTaken).toHaveBeenCalledWith('product-finite')
	})

	it('takes nothing off when no seats are taken', async () => {
		mocks.getProduct.mockResolvedValue({ quantityAvailable: 40 })
		mocks.getSeatsTaken.mockResolvedValue(0)

		const result = await getPricingData({ productId: 'product-finite' })

		expect(result.quantityAvailable).toBe(40)
	})

	it('never goes below zero, so an overshoot is sold out and not the -1 unlimited sentinel', async () => {
		for (const [cap, taken] of [
			[40, 40],
			[40, 41],
			[1, 2],
			[1, 50],
		] as const) {
			mocks.getProduct.mockResolvedValue({ quantityAvailable: cap })
			mocks.getSeatsTaken.mockResolvedValue(taken)
			const result = await getPricingData({ productId: 'product-finite' })
			expect(result.quantityAvailable, `${cap}/${taken}`).toBe(0)
		}
	})
})
