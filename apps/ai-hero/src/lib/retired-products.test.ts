import { describe, expect, it } from 'vitest'

import {
	isRetiredProduct,
	withoutRetiredWorkshopProducts,
} from './retired-products'

describe('retired products', () => {
	it('names the AI SDK v6 Crash Course and nothing else we sell', () => {
		expect(isRetiredProduct('product-9wdta')).toBe(true)
		expect(isRetiredProduct('product-s00zs')).toBe(false)
		expect(isRetiredProduct('product-ma254')).toBe(false)
		expect(isRetiredProduct(null)).toBe(false)
		expect(isRetiredProduct(undefined)).toBe(false)
	})

	it("drops a retired workshop's whole offer, including an older bundle", () => {
		expect(
			withoutRetiredWorkshopProducts([
				{ id: 'product-9wdta' },
				{ id: 'product-wdhub' },
			]),
		).toEqual([])
		expect(
			withoutRetiredWorkshopProducts([
				{ id: 'product-wdhub' },
				{ id: 'product-9wdta' },
			]),
		).toEqual([])
	})

	it("leaves every other workshop's products as they were", () => {
		const products = [{ id: 'product-ma254' }, { id: 'product-wdhub' }]
		expect(withoutRetiredWorkshopProducts(products)).toEqual(products)
		expect(withoutRetiredWorkshopProducts([])).toEqual([])
	})
})
