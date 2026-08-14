import { NextRequest } from 'next/server'
import { describe, expect, it } from 'vitest'

import { protectCourseBuilderRequest } from './coursebuilder-request-authorization'

const protectedMerchantCoupon = {
	id: 'merchant-prior-credit',
	type: 'special credit',
}
const publicMerchantCoupon = { id: 'merchant-public', type: 'special' }
const pppMerchantCoupon = { id: 'merchant-ppp', type: 'ppp' }
const bulkMerchantCoupon = { id: 'merchant-bulk', type: 'bulk' }
const protectedCoupon = {
	id: 'coupon-prior-credit',
	merchantCouponId: protectedMerchantCoupon.id,
	restrictedToProductId: 'product-crash-course',
	fields: { exclusive: true },
}
const publicCoupon = {
	id: 'coupon-public',
	merchantCouponId: publicMerchantCoupon.id,
	restrictedToProductId: 'product-crash-course',
	fields: {},
}
const entitlement = {
	id: 'entitlement-prior-credit',
	userId: 'user-entitled',
	sourceType: 'COUPON',
	sourceId: protectedCoupon.id,
	entitlementType: 'entitlement-type-special-credit',
	deletedAt: null,
	expiresAt: null,
}

const createAdapter = ({ entitled = false } = {}) => ({
	getMerchantCoupon: async (id: string) =>
		[
			protectedMerchantCoupon,
			publicMerchantCoupon,
			pppMerchantCoupon,
			bulkMerchantCoupon,
		].find((coupon) => coupon.id === id) ?? null,
	getCoupon: async (id: string) =>
		[protectedCoupon, publicCoupon].find((coupon) => coupon.id === id) ?? null,
	getEntitlementTypeByName: async () => ({
		id: 'entitlement-type-special-credit',
	}),
	getEntitlementsForUser: async () => (entitled ? [entitlement] : []),
})

const protect = (
	request: NextRequest,
	{
		verifiedUserId,
		entitled = false,
	}: { verifiedUserId?: string; entitled?: boolean } = {},
) =>
	protectCourseBuilderRequest(request, {
		adapter: createAdapter({ entitled }) as never,
		verifiedUserId,
	})

describe('protectCourseBuilderRequest', () => {
	it('removes forged identity and protected input from formatted pricing', async () => {
		const request = new NextRequest(
			'https://aihero.dev/api/coursebuilder/prices-formatted',
			{
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					productId: 'product-crash-course',
					quantity: 1,
					userId: 'user-entitled',
					couponId: protectedCoupon.id,
					merchantCoupon: protectedMerchantCoupon,
				}),
			},
		)

		const protectedRequest = await protect(request)
		const body = await protectedRequest.json()

		expect(body).toEqual({
			productId: 'product-crash-course',
			quantity: 1,
		})
	})

	it('keeps entitled formatted pricing bound to the verified user', async () => {
		const request = new NextRequest(
			'https://aihero.dev/api/coursebuilder/prices-formatted',
			{
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					productId: 'product-crash-course',
					quantity: 1,
					userId: 'user-forged',
					couponId: protectedCoupon.id,
					merchantCoupon: protectedMerchantCoupon,
				}),
			},
		)

		const protectedRequest = await protect(request, {
			verifiedUserId: entitlement.userId,
			entitled: true,
		})
		const body = await protectedRequest.json()

		expect(body).toEqual(
			expect.objectContaining({
				userId: entitlement.userId,
				couponId: protectedCoupon.id,
				merchantCoupon: protectedMerchantCoupon,
			}),
		)
	})

	it('replaces checkout identity with the verified user', async () => {
		const request = new NextRequest(
			'https://aihero.dev/api/coursebuilder/checkout/stripe?productId=product-crash-course&quantity=1&cancelUrl=%2F&userId=user-entitled',
			{ method: 'POST' },
		)

		const protectedRequest = await protect(request, {
			verifiedUserId: 'user-actual',
		})

		expect(protectedRequest.nextUrl.searchParams.get('userId')).toBe(
			'user-actual',
		)
	})

	it('removes a protected checkout selector for an unentitled caller', async () => {
		const request = new NextRequest(
			`https://aihero.dev/api/coursebuilder/checkout/stripe?productId=product-crash-course&quantity=1&cancelUrl=%2F&couponId=${protectedMerchantCoupon.id}&usedCouponId=${protectedCoupon.id}&userId=user-entitled`,
			{ method: 'POST' },
		)

		const protectedRequest = await protect(request)

		expect(protectedRequest.nextUrl.searchParams.has('userId')).toBe(false)
		expect(protectedRequest.nextUrl.searchParams.has('couponId')).toBe(false)
		expect(protectedRequest.nextUrl.searchParams.has('usedCouponId')).toBe(
			false,
		)
	})

	it('preserves the entitled quantity-one checkout selector', async () => {
		const request = new NextRequest(
			`https://aihero.dev/api/coursebuilder/checkout/stripe?productId=product-crash-course&quantity=1&cancelUrl=%2F&couponId=${protectedMerchantCoupon.id}&usedCouponId=${protectedCoupon.id}`,
			{ method: 'POST' },
		)

		const protectedRequest = await protect(request, {
			verifiedUserId: entitlement.userId,
			entitled: true,
		})

		expect(protectedRequest.nextUrl.searchParams.get('couponId')).toBe(
			protectedMerchantCoupon.id,
		)
		expect(protectedRequest.nextUrl.searchParams.get('usedCouponId')).toBe(
			protectedCoupon.id,
		)
		expect(protectedRequest.nextUrl.searchParams.get('userId')).toBe(
			entitlement.userId,
		)
	})

	it('strips an exclusive credit from a team checkout', async () => {
		const request = new NextRequest(
			`https://aihero.dev/api/coursebuilder/checkout/stripe?productId=product-crash-course&quantity=2&cancelUrl=%2F&couponId=${protectedMerchantCoupon.id}&usedCouponId=${protectedCoupon.id}`,
			{ method: 'POST' },
		)

		const protectedRequest = await protect(request, {
			verifiedUserId: entitlement.userId,
			entitled: true,
		})

		expect(protectedRequest.nextUrl.searchParams.has('couponId')).toBe(false)
		expect(protectedRequest.nextUrl.searchParams.has('usedCouponId')).toBe(
			false,
		)
	})

	it('keeps ordinary public checkout coupons compatible', async () => {
		const request = new NextRequest(
			`https://aihero.dev/api/coursebuilder/checkout/stripe?productId=product-crash-course&quantity=1&cancelUrl=%2F&couponId=${publicMerchantCoupon.id}&usedCouponId=${publicCoupon.id}`,
			{ method: 'POST' },
		)

		const protectedRequest = await protect(request)

		expect(protectedRequest.nextUrl.searchParams.get('couponId')).toBe(
			publicMerchantCoupon.id,
		)
		expect(protectedRequest.nextUrl.searchParams.get('usedCouponId')).toBe(
			publicCoupon.id,
		)
	})

	it.each([pppMerchantCoupon, bulkMerchantCoupon])(
		'keeps normal $type pricing compatible',
		async (merchantCoupon) => {
			const request = new NextRequest(
				`https://aihero.dev/api/coursebuilder/checkout/stripe?productId=product-crash-course&quantity=1&cancelUrl=%2F&couponId=${merchantCoupon.id}`,
				{ method: 'POST' },
			)

			const protectedRequest = await protect(request)

			expect(protectedRequest.nextUrl.searchParams.get('couponId')).toBe(
				merchantCoupon.id,
			)
		},
	)
})
