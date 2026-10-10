import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	calls: [] as string[],
	authoritativePrice: vi.fn(),
}))

vi.mock('@/db', () => ({
	courseBuilderAdapter: { authoritativePrice: mocks.authoritativePrice },
}))
vi.mock('@/server/auth', () => ({
	getServerAuthSession: vi.fn(async () => ({ session: null })),
}))
vi.mock('@/lib/purchase-disputes', () => ({
	isUserBlockedFromPurchasing: vi.fn(async () => false),
}))
vi.mock('@/coursebuilder/server-computed-checkout-coupon', () => ({
	resolveServerComputedCheckoutCoupon: vi.fn(async () => null),
}))
vi.mock('@/coursebuilder/coursebuilder-request-authorization', () => ({
	protectCourseBuilderRequest: vi.fn(async (request: NextRequest) => {
		mocks.calls.push('authorize-coupons')
		return request
	}),
}))

import { protectCourseBuilderRequest } from '@/coursebuilder/coursebuilder-request-authorization'
import { PURCHASE_BLOCKED_ERROR_PATH } from '@/coursebuilder/purchase-block-checkout'

import { protectCommerceRequest } from './protect-commerce-request'

const C5 = 'product-s00zs'
const checkout = (productId: string) =>
	new NextRequest(
		`https://app.test/api/coursebuilder/checkout/stripe?productId=${productId}&priceId=price-1&quantity=1&couponId=forged`,
		{ method: 'POST' },
	)

beforeEach(() => {
	mocks.calls = []
	vi.mocked(protectCourseBuilderRequest).mockClear()
	mocks.authoritativePrice.mockClear()
})

describe('protectCommerceRequest', () => {
	it('refuses a chargeback-blocked buyer before any coupon or pricing work', async () => {
		const isBlocked = vi.fn(async () => {
			mocks.calls.push('purchase-block')
			return true
		})
		const { request } = await protectCommerceRequest(checkout(C5), {
			session: async () => ({ userId: 'user-blocked' }),
			isBlocked,
		})
		expect(request).toBeInstanceOf(Response)
		const response = request as Response
		expect(response.status).toBe(303)
		expect(new URL(response.headers.get('location')!).pathname +
			new URL(response.headers.get('location')!).search).toBe(
			PURCHASE_BLOCKED_ERROR_PATH,
		)
		expect(mocks.calls).toEqual(['purchase-block'])
		expect(protectCourseBuilderRequest).not.toHaveBeenCalled()
		expect(mocks.authoritativePrice).not.toHaveBeenCalled()
	})

	it('runs the purchase block first, then coupon authorization, for a buyer it lets through', async () => {
		const { request, userId } = await protectCommerceRequest(checkout(C5), {
			session: async () => ({ userId: 'user-1' }),
			isBlocked: async () => {
				mocks.calls.push('purchase-block')
				return false
			},
		})
		expect(request).toBeInstanceOf(NextRequest)
		expect(userId).toBe('user-1')
		expect(mocks.calls).toEqual(['purchase-block', 'authorize-coupons'])
		expect(protectCourseBuilderRequest).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				verifiedUserId: 'user-1',
				authoritativeProductIds: expect.any(Set),
			}),
		)
	})

	it('sends an anonymous C5 checkout to sign in without creating a session', async () => {
		const { request } = await protectCommerceRequest(checkout(C5), {
			session: async () => ({}),
		})
		expect(request).toBeInstanceOf(Response)
		const location = new URL((request as Response).headers.get('location')!)
		expect((request as Response).status).toBe(303)
		expect(location.pathname).toBe('/subscribe/verify-login')
		expect(location.searchParams.get('productId')).toBe(C5)
		expect(mocks.authoritativePrice).not.toHaveBeenCalled()
	})

	it('leaves an anonymous checkout for any other product to Course Builder', async () => {
		const { request } = await protectCommerceRequest(checkout('product-ma254'), {
			session: async () => ({}),
		})
		expect(request).toBeInstanceOf(NextRequest)
	})
})
