import { beforeEach, describe, expect, it, vi } from 'vitest'

// The cohort page's slug map is cached under the `products` tag and has no
// write path of its own: it relies on every product write here calling
// `revalidateProducts()`. These pin that the CMS create, update (which is
// also how a slug changes) and archive all do.
const mocks = vi.hoisted(() => ({
	revalidateProducts: vi.fn(),
	createProduct: vi.fn(async () => ({ id: 'p1' })),
	updateProduct: vi.fn(async (input: unknown) => input),
	archiveProduct: vi.fn(async () => ({ id: 'p1' })),
	can: vi.fn(() => true),
}))

vi.mock('@/lib/product-cache', () => ({
	revalidateProducts: mocks.revalidateProducts,
}))
vi.mock('@/db', () => ({
	db: {},
	courseBuilderAdapter: {
		createProduct: mocks.createProduct,
		updateProduct: mocks.updateProduct,
		archiveProduct: mocks.archiveProduct,
	},
}))
vi.mock('@/db/schema', () => ({}))
vi.mock('@/coursebuilder/stripe-provider', () => ({ stripeProvider: {} }))
vi.mock('@/server/logger', () => ({ log: { error: vi.fn() } }))
vi.mock('@/server/auth', () => ({
	getServerAuthSession: vi.fn(async () => ({
		session: { user: { id: 'admin' } },
		ability: { can: mocks.can },
	})),
}))

import { archiveProduct, createProduct, updateProduct } from './products-query'

beforeEach(() => {
	mocks.revalidateProducts.mockClear()
	mocks.can.mockReturnValue(true)
})

describe('product writes revalidate the products tag', () => {
	it('on create', async () => {
		await createProduct({ name: 'New', quantityAvailable: -1, price: 10 } as any)
		expect(mocks.revalidateProducts).toHaveBeenCalledOnce()
	})

	it('on update, including a slug change', async () => {
		await updateProduct({ id: 'p1', fields: { slug: 'renamed' } } as any)
		expect(mocks.updateProduct).toHaveBeenCalledWith(
			expect.objectContaining({ fields: { slug: 'renamed' } }),
		)
		expect(mocks.revalidateProducts).toHaveBeenCalledOnce()
	})

	it('on archive', async () => {
		await archiveProduct('p1')
		expect(mocks.revalidateProducts).toHaveBeenCalledOnce()
	})

	it('not when the write is refused', async () => {
		mocks.can.mockReturnValue(false)
		await expect(archiveProduct('p1')).rejects.toThrow('Unauthorized')
		expect(mocks.revalidateProducts).not.toHaveBeenCalled()
	})
})
