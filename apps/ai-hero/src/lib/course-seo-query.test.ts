import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	getProduct: vi.fn(),
	getSeatsTaken: vi.fn(),
}))
vi.mock('next/cache', () => ({ unstable_cache: (fn: unknown) => fn }))
vi.mock('./products-query', () => ({ getProduct: mocks.getProduct }))
vi.mock('@/db', () => ({ db: {} }))
vi.mock('@/db/schema', () => ({ coupon: 'Coupon', purchases: 'Purchase' }))
vi.mock('./seats-taken-query', async (importOriginal) => ({
	...(await importOriginal<typeof import('./seats-taken-query')>()),
	getSeatsTaken: mocks.getSeatsTaken,
}))
import { getCourseSeoCommerce } from './course-seo-query'

describe('anonymous SEO commerce facts', () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})
	it('uses the primary product price, and seat holdings instead of raw purchase count', async () => {
		const product = {
			id: 'synthetic-product',
			quantityAvailable: 10,
			price: { unitAmount: 347 },
		}
		mocks.getProduct.mockResolvedValue(product)
		mocks.getSeatsTaken.mockResolvedValue(12)
		expect(await getCourseSeoCommerce(product.id)).toEqual({
			product,
			quantityAvailable: 0,
		})
		expect(mocks.getSeatsTaken).toHaveBeenCalledWith(product.id)
	})
	it('does not invent inventory for an unknown cap', async () => {
		mocks.getProduct.mockResolvedValue({
			id: 'synthetic-product',
			quantityAvailable: null,
		})
		expect(
			(await getCourseSeoCommerce('synthetic-product'))?.quantityAvailable,
		).toBeUndefined()
		expect(mocks.getSeatsTaken).not.toHaveBeenCalled()
	})
	it('omits commerce facts when the seat reading fails', async () => {
		mocks.getProduct.mockResolvedValue({ quantityAvailable: 10 })
		mocks.getSeatsTaken.mockRejectedValue(
			new Error('Synthetic unavailable reading'),
		)
		expect(await getCourseSeoCommerce('synthetic-product')).toBeUndefined()
	})
	it('does not read seats for unlimited inventory', async () => {
		mocks.getProduct.mockResolvedValue({ quantityAvailable: -1 })
		expect(
			(await getCourseSeoCommerce('synthetic-product'))?.quantityAvailable,
		).toBe(-1)
		expect(mocks.getSeatsTaken).not.toHaveBeenCalled()
	})
})
