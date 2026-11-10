import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	calls: [] as string[],
	authoritativePrice: vi.fn(),
	serverComputedCoupon: vi.fn(async (): Promise<unknown> => null),
	getMerchantCoupon: vi.fn(async (): Promise<unknown> => null),
}))

vi.mock('@/db', () => ({
	courseBuilderAdapter: {
		authoritativePrice: mocks.authoritativePrice,
		getMerchantCoupon: mocks.getMerchantCoupon,
	},
	db: { query: { purchases: { findMany: vi.fn(async () => []) } } },
}))
vi.mock('@/db/schema', () => ({ purchases: {} }))
vi.mock('@/lib/products-query', () => ({
	getProduct: vi.fn(async () => ({ type: 'cohort' })),
}))
vi.mock('@/server/auth', () => ({
	getServerAuthSession: vi.fn(async () => ({ session: null })),
}))
vi.mock('@/lib/purchase-disputes', () => ({
	isUserBlockedFromPurchasing: vi.fn(async () => false),
}))
vi.mock('@/coursebuilder/server-computed-checkout-coupon', () => ({
	resolveServerComputedCheckoutCoupon: mocks.serverComputedCoupon,
}))
vi.mock('@/coursebuilder/coursebuilder-request-authorization', () => ({
	protectCourseBuilderRequest: vi.fn(async (request: NextRequest) => {
		mocks.calls.push('authorize-coupons')
		return request
	}),
}))

import { protectCourseBuilderRequest } from '@/coursebuilder/coursebuilder-request-authorization'
import { PURCHASE_BLOCKED_ERROR_PATH } from '@/coursebuilder/purchase-block-checkout'
import {
	ALREADY_OWN_PATH,
	INVALID_QUANTITY_PATH,
	REGIONAL_TEAM_NOT_ALLOWED_PATH,
} from '@/lib/purchase-guardrails'
import { REGIONAL_UPGRADE_PATH } from '@/lib/c5-pricing/products'

import { AUTHORITATIVE_PPP_OFFER_ID } from '@coursebuilder/commerce/authoritative-price'

import { protectCommerceRequest } from './protect-commerce-request'

const VALID = [{ status: 'Valid', bulk: false }]
const RESTRICTED = [{ status: 'Restricted', bulk: false }]

const C5 = 'product-s00zs'
const checkout = (productId: string, quantity = 1, couponId = 'forged') =>
	new NextRequest(
		`https://app.test/api/coursebuilder/checkout/stripe?productId=${productId}&priceId=price-1&quantity=${quantity}&couponId=${couponId}`,
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

	it('sends a single-seat Restricted holder to support, not to a checkout error', async () => {
		const { request } = await protectCommerceRequest(checkout(C5), {
			session: async () => ({ userId: 'user-regional' }),
			isBlocked: async () => false,
			existingPurchases: async () => RESTRICTED,
		})
		expect(request).toBeInstanceOf(Response)
		const location = new URL((request as Response).headers.get('location')!)
		expect((request as Response).status).toBe(303)
		expect(location.pathname + location.search).toBe(REGIONAL_UPGRADE_PATH)
		expect(mocks.authoritativePrice).not.toHaveBeenCalled()
	})

	it('refuses a single-seat duplicate from a Valid holder at the checkout POST', async () => {
		const { request } = await protectCommerceRequest(checkout(C5, 1), {
			session: async () => ({ userId: 'user-owner' }),
			isBlocked: async () => false,
			existingPurchases: async () => VALID,
		})
		const location = new URL((request as Response).headers.get('location')!)
		expect(location.pathname + location.search).toBe(ALREADY_OWN_PATH)
	})

	it('also refuses the duplicate on a non-authoritative cohort product', async () => {
		const { request } = await protectCommerceRequest(
			checkout('product-other', 1),
			{
				session: async () => ({ userId: 'user-owner' }),
				isBlocked: async () => false,
				existingPurchases: async () => VALID,
			},
		)
		const location = new URL((request as Response).headers.get('location')!)
		expect(location.pathname + location.search).toBe(ALREADY_OWN_PATH)
	})

	it('does not refuse a duplicate of an unguarded product type', async () => {
		const { request } = await protectCommerceRequest(
			checkout('product-ma254', 1),
			{
				session: async () => ({ userId: 'user-owner' }),
				isBlocked: async () => false,
				existingPurchases: async () => VALID,
				productType: async () => 'self-paced',
			},
		)
		expect(request).toBeInstanceOf(NextRequest)
	})

	it.each([
		['Valid holder', VALID],
		['Restricted holder', RESTRICTED],
		['no purchases', []],
	])('lets a %s start a team checkout at quantity 2', async (_n, existing) => {
		const { request } = await protectCommerceRequest(checkout(C5, 2, 'none'), {
			session: async () => ({ userId: 'user-holder' }),
			isBlocked: async () => false,
			existingPurchases: async () => existing,
		})
		expect(request).toBeInstanceOf(NextRequest)
	})

	it('refuses the authoritative regional offer on a team order, never stripping it', async () => {
		const { request } = await protectCommerceRequest(
			checkout(C5, 5, AUTHORITATIVE_PPP_OFFER_ID),
			{
				session: async () => ({ userId: 'user-1' }),
				isBlocked: async () => false,
				existingPurchases: async () => [],
			},
		)
		const location = new URL((request as Response).headers.get('location')!)
		expect(location.pathname + location.search).toBe(
			REGIONAL_TEAM_NOT_ALLOWED_PATH,
		)
	})

	it('lets the authoritative regional offer through at quantity 1', async () => {
		const { request } = await protectCommerceRequest(
			checkout(C5, 1, AUTHORITATIVE_PPP_OFFER_ID),
			{
				session: async () => ({ userId: 'user-1' }),
				isBlocked: async () => false,
				existingPurchases: async () => [],
			},
		)
		expect(request).toBeInstanceOf(NextRequest)
	})

	it('refuses a server-computed PPP coupon on a team order (non-authoritative product)', async () => {
		mocks.serverComputedCoupon.mockResolvedValueOnce({
			id: 'mc-ppp',
			type: 'ppp',
		})
		vi.mocked(protectCourseBuilderRequest).mockImplementationOnce(
			async (request, options) => {
				// What the real protector does: drop the raw coupon, attach the server's.
				const url = new URL(request.url)
				url.searchParams.delete('couponId')
				const coupon = await options.resolveServerComputedMerchantCoupon?.({
					productId: 'product-other',
					quantity: 5,
					country: 'US',
				})
				if (coupon) url.searchParams.set('couponId', coupon.id)
				return new NextRequest(url, { method: 'POST' })
			},
		)
		const { request } = await protectCommerceRequest(
			checkout('product-other', 5, 'forged'),
			{
				session: async () => ({ userId: 'user-1' }),
				isBlocked: async () => false,
				existingPurchases: async () => [],
			},
		)
		const location = new URL((request as Response).headers.get('location')!)
		expect(location.pathname + location.search).toBe(
			REGIONAL_TEAM_NOT_ALLOWED_PATH,
		)
	})

	it('reads the final coupon: a raw regional coupon the protector dropped is not refused', async () => {
		vi.mocked(protectCourseBuilderRequest).mockImplementationOnce(
			async (request) => {
				const url = new URL(request.url)
				url.searchParams.delete('couponId')
				return new NextRequest(url, { method: 'POST' })
			},
		)
		const { request } = await protectCommerceRequest(
			checkout('product-other', 5, AUTHORITATIVE_PPP_OFFER_ID),
			{
				session: async () => ({ userId: 'user-1' }),
				isBlocked: async () => false,
				existingPurchases: async () => [],
			},
		)
		expect(request).toBeInstanceOf(NextRequest)
	})

	it('refuses a client-sent PPP merchant coupon the protector kept, on a team order of a non-authoritative product', async () => {
		mocks.getMerchantCoupon.mockResolvedValueOnce({ id: 'mc-client', type: 'ppp' })
		const { request } = await protectCommerceRequest(
			checkout('product-other', 5, 'mc-client'),
			{
				session: async () => ({ userId: 'user-1' }),
				isBlocked: async () => false,
				existingPurchases: async () => [],
			},
		)
		expect(mocks.getMerchantCoupon).toHaveBeenCalledWith('mc-client')
		const location = new URL((request as Response).headers.get('location')!)
		expect(location.pathname + location.search).toBe(
			REGIONAL_TEAM_NOT_ALLOWED_PATH,
		)
	})

	it('lets a kept client coupon of another type through on a team order', async () => {
		mocks.getMerchantCoupon.mockResolvedValueOnce({ id: 'mc-special', type: 'special' })
		const { request } = await protectCommerceRequest(
			checkout('product-other', 5, 'mc-special'),
			{
				session: async () => ({ userId: 'user-1' }),
				isBlocked: async () => false,
				existingPurchases: async () => [],
			},
		)
		expect(request).toBeInstanceOf(NextRequest)
	})

	it('reads the last value of a repeated quantity, as Course Builder does', async () => {
		const url = new URL(checkout(C5, 2, 'none').url)
		url.searchParams.append('quantity', '1')
		const { request } = await protectCommerceRequest(
			new NextRequest(url, { method: 'POST' }),
			{
				session: async () => ({ userId: 'user-owner' }),
				isBlocked: async () => false,
				existingPurchases: async () => VALID,
			},
		)
		const location = new URL((request as Response).headers.get('location')!)
		expect(location.pathname + location.search).toBe(ALREADY_OWN_PATH)
	})

	it('skips the product and purchase lookups on a team order with no regional coupon', async () => {
		const existingPurchases = vi.fn(async () => VALID)
		const productType = vi.fn(async () => 'cohort')
		await protectCommerceRequest(checkout(C5, 5, 'none'), {
			session: async () => ({ userId: 'user-1' }),
			isBlocked: async () => false,
			existingPurchases,
			productType,
		})
		expect(existingPurchases).not.toHaveBeenCalled()
		expect(productType).not.toHaveBeenCalled()
	})

	it('lets a server-computed bulk coupon through on a team order', async () => {
		mocks.serverComputedCoupon.mockResolvedValueOnce({
			id: 'mc-bulk',
			type: 'bulk',
		})
		vi.mocked(protectCourseBuilderRequest).mockImplementationOnce(
			async (request, options) => {
				const url = new URL(request.url)
				const coupon = await options.resolveServerComputedMerchantCoupon?.({
					productId: 'product-other',
					quantity: 5,
					country: 'US',
				})
				if (coupon) url.searchParams.set('couponId', coupon.id)
				return new NextRequest(url, { method: 'POST' })
			},
		)
		const { request } = await protectCommerceRequest(
			checkout('product-other', 5, 'none'),
			{
				session: async () => ({ userId: 'user-1' }),
				isBlocked: async () => false,
				existingPurchases: async () => [],
			},
		)
		expect(request).toBeInstanceOf(NextRequest)
	})

	it.each(['0', '-1', '2.5', '1e1', 'abc'])(
		'refuses quantity %s',
		async (quantity) => {
			const { request } = await protectCommerceRequest(
				checkout(C5, quantity as unknown as number),
				{
					session: async () => ({ userId: 'user-1' }),
					isBlocked: async () => false,
					existingPurchases: async () => [],
				},
			)
			const location = new URL((request as Response).headers.get('location')!)
			expect(location.pathname + location.search).toBe(INVALID_QUANTITY_PATH)
		},
	)

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
		const { request } = await protectCommerceRequest(
			checkout('product-ma254'),
			{
				session: async () => ({}),
			},
		)
		expect(request).toBeInstanceOf(NextRequest)
	})
})
