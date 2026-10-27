import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { GET } from './route'

const mocks = vi.hoisted(() => ({ purchase: vi.fn(), product: vi.fn() }))
vi.mock('@/db', () => ({
	courseBuilderAdapter: {
		getPurchaseByCheckoutSessionId: mocks.purchase,
		getProduct: mocks.product,
	},
}))

describe('DB-only checkout status', () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})
	it('returns processing, never an invented payment failure, for a DB miss even after many attempts', async () => {
		mocks.purchase.mockResolvedValue(null)
		const response = await GET(
			new NextRequest(
				'https://example.test/api/commerce/checkout-status?session_id=cs_test_synthetic&attempt=1000',
			),
		)
		expect(await response.json()).toEqual({ status: 'processing' })
		expect(mocks.product).not.toHaveBeenCalled()
		expect(response.headers.get('cache-control')).toBe('no-store')
	})
	it('returns only public product details once the purchase exists', async () => {
		mocks.purchase.mockResolvedValue({
			id: 'purchase-synthetic',
			productId: 'course-synthetic',
			userId: 'not-returned',
		})
		mocks.product.mockResolvedValue({
			name: 'Synthetic course',
			fields: {
				image: { url: 'https://example.test/course.png' },
				private: 'not-returned',
			},
		})
		const response = await GET(
			new NextRequest(
				'https://example.test/api/commerce/checkout-status?session_id=cs_test_synthetic',
			),
		)
		expect(await response.json()).toEqual({
			status: 'ready',
			purchaseId: 'purchase-synthetic',
			product: {
				name: 'Synthetic course',
				image: 'https://example.test/course.png',
			},
		})
	})
	it('rejects invalid IDs without database work', async () => {
		const response = await GET(
			new NextRequest(
				'https://example.test/api/commerce/checkout-status?session_id=invalid',
			),
		)
		expect(response.status).toBe(400)
		expect(mocks.purchase).not.toHaveBeenCalled()
	})
})
