import { NextRequest } from 'next/server'
import { describe, expect, it, vi } from 'vitest'

import { protectCourseBuilderRequest } from './coursebuilder-request-authorization'

const protectedMerchantCoupon = {
	id: 'merchant-prior-credit',
	type: 'special credit',
	status: 1,
}
const publicMerchantCoupon = {
	id: 'merchant-public',
	type: 'special',
	status: 1,
}
const pppMerchantCoupon = {
	id: 'merchant-ppp',
	type: 'ppp',
	status: 1,
}
const bulkMerchantCoupon = {
	id: 'merchant-bulk',
	type: 'bulk',
	status: 1,
}
const protectedCoupon = {
	id: 'coupon-prior-credit',
	merchantCouponId: protectedMerchantCoupon.id,
	restrictedToProductId: 'product-crash-course',
	fields: { exclusive: true },
	status: 1,
	expires: null,
	maxUses: -1,
	usedCount: 0,
}
const publicCoupon = {
	id: 'coupon-public',
	merchantCouponId: publicMerchantCoupon.id,
	restrictedToProductId: 'product-crash-course',
	fields: {},
	status: 1,
	expires: null,
	maxUses: -1,
	usedCount: 0,
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
		serverComputedMerchantCoupon,
	}: {
		verifiedUserId?: string
		entitled?: boolean
		serverComputedMerchantCoupon?: { id: string; type: string }
	} = {},
) =>
	protectCourseBuilderRequest(request, {
		adapter: createAdapter({ entitled }) as never,
		verifiedUserId,
		resolveServerComputedMerchantCoupon: serverComputedMerchantCoupon
			? vi.fn(async () => serverComputedMerchantCoupon)
			: undefined,
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

	it('re-enables autoApplyPPP when stripping a PPP selection from formatted pricing', async () => {
		const request = new NextRequest(
			'https://aihero.dev/api/coursebuilder/prices-formatted',
			{
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					productId: 'product-crash-course',
					quantity: 1,
					autoApplyPPP: false,
					merchantCoupon: pppMerchantCoupon,
				}),
			},
		)

		const protectedRequest = await protect(request)
		const body = await protectedRequest.json()

		expect(body).toEqual({
			productId: 'product-crash-course',
			quantity: 1,
			autoApplyPPP: true,
		})
	})

	it('sanitizes supported form-encoded formatted pricing', async () => {
		const form = new URLSearchParams({
			productId: 'product-crash-course',
			quantity: '1',
			userId: entitlement.userId,
			couponId: protectedCoupon.id,
			autoApplyPPP: 'true',
		})
		const request = new NextRequest(
			'https://aihero.dev/api/coursebuilder/prices-formatted',
			{
				method: 'POST',
				headers: {
					'content-type': 'application/x-www-form-urlencoded',
				},
				body: form,
			},
		)

		const protectedRequest = await protect(request)
		const body = await protectedRequest.json()

		expect(protectedRequest.headers.get('content-type')).toBe(
			'application/json',
		)
		expect(body).toEqual({
			productId: 'product-crash-course',
			quantity: 1,
			autoApplyPPP: true,
		})
	})

	it('binds entitled form pricing to the verified user', async () => {
		const form = new URLSearchParams({
			productId: 'product-crash-course',
			quantity: '1',
			userId: 'user-forged',
			couponId: protectedCoupon.id,
		})
		const request = new NextRequest(
			'https://aihero.dev/api/coursebuilder/prices-formatted',
			{
				method: 'POST',
				headers: {
					'content-type': 'application/x-www-form-urlencoded',
				},
				body: form,
			},
		)

		const protectedRequest = await protect(request, {
			verifiedUserId: entitlement.userId,
			entitled: true,
		})
		const body = await protectedRequest.json()

		expect(body).toEqual(
			expect.objectContaining({
				productId: 'product-crash-course',
				quantity: 1,
				userId: entitlement.userId,
				couponId: protectedCoupon.id,
			}),
		)
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

	it.each([
		{
			name: 'public first and protected last',
			couponIds: [publicMerchantCoupon.id, protectedMerchantCoupon.id],
			expectedCouponId: undefined,
		},
		{
			name: 'protected first and public last',
			couponIds: [protectedMerchantCoupon.id, publicMerchantCoupon.id],
			expectedCouponId: publicMerchantCoupon.id,
		},
	])('normalizes duplicate coupon selectors: $name', async (scenario) => {
		const url = new URL('https://aihero.dev/api/coursebuilder/checkout/stripe')
		url.searchParams.set('productId', 'product-crash-course')
		url.searchParams.set('quantity', '1')
		url.searchParams.set('cancelUrl', '/')
		for (const couponId of scenario.couponIds) {
			url.searchParams.append('couponId', couponId)
		}
		url.searchParams.set('usedCouponId', publicCoupon.id)

		const protectedRequest = await protect(
			new NextRequest(url, { method: 'POST' }),
		)

		expect(protectedRequest.nextUrl.searchParams.getAll('couponId')).toEqual(
			scenario.expectedCouponId ? [scenario.expectedCouponId] : [],
		)
		expect(
			protectedRequest.nextUrl.searchParams.getAll('usedCouponId').length,
		).toBeLessThanOrEqual(1)
	})

	it.each([
		{
			name: 'public first and protected last',
			usedCouponIds: [publicCoupon.id, protectedCoupon.id],
			expectedCouponId: undefined,
		},
		{
			name: 'protected first and public last',
			usedCouponIds: [protectedCoupon.id, publicCoupon.id],
			expectedCouponId: publicMerchantCoupon.id,
		},
	])('normalizes duplicate site coupon provenance: $name', async (scenario) => {
		const url = new URL('https://aihero.dev/api/coursebuilder/checkout/stripe')
		url.searchParams.set('productId', 'product-crash-course')
		url.searchParams.set('quantity', '1')
		url.searchParams.set('cancelUrl', '/')
		url.searchParams.set('couponId', publicMerchantCoupon.id)
		for (const usedCouponId of scenario.usedCouponIds) {
			url.searchParams.append('usedCouponId', usedCouponId)
		}

		const protectedRequest = await protect(
			new NextRequest(url, { method: 'POST' }),
		)

		expect(protectedRequest.nextUrl.searchParams.getAll('couponId')).toEqual(
			scenario.expectedCouponId ? [scenario.expectedCouponId] : [],
		)
		expect(
			protectedRequest.nextUrl.searchParams.getAll('usedCouponId'),
		).toEqual(scenario.expectedCouponId ? [publicCoupon.id] : [])
	})

	it('normalizes duplicate product, quantity, identity, bulk, and upgrade keys', async () => {
		const url = new URL('https://aihero.dev/api/coursebuilder/checkout/stripe')
		for (const [key, value] of [
			['productId', 'product-crash-course'],
			['productId', 'product-other'],
			['quantity', '1'],
			['quantity', '2'],
			['userId', 'user-forged-one'],
			['userId', 'user-forged-two'],
			['bulk', 'false'],
			['bulk', 'true'],
			['upgradeFromPurchaseId', 'purchase-one'],
			['upgradeFromPurchaseId', 'purchase-two'],
			['couponId', protectedMerchantCoupon.id],
			['usedCouponId', protectedCoupon.id],
		] as const) {
			url.searchParams.append(key, value)
		}

		const protectedRequest = await protect(
			new NextRequest(url, { method: 'POST' }),
			{
				verifiedUserId: entitlement.userId,
				entitled: true,
			},
		)
		const params = protectedRequest.nextUrl.searchParams

		expect(params.get('productId')).toBe('product-other')
		expect(params.get('quantity')).toBe('2')
		expect(params.get('userId')).toBe(entitlement.userId)
		expect(params.get('bulk')).toBe('true')
		expect(params.get('upgradeFromPurchaseId')).toBe('purchase-two')
		expect(params.has('couponId')).toBe(false)
		expect(params.has('usedCouponId')).toBe(false)
		for (const key of [
			'productId',
			'quantity',
			'couponId',
			'usedCouponId',
			'userId',
			'bulk',
			'upgradeFromPurchaseId',
		]) {
			expect(params.getAll(key).length).toBeLessThanOrEqual(1)
		}
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

	it('replaces submitted provenance with the entitlement source coupon', async () => {
		const request = new NextRequest(
			`https://aihero.dev/api/coursebuilder/checkout/stripe?productId=product-crash-course&quantity=1&cancelUrl=%2F&couponId=${protectedMerchantCoupon.id}&usedCouponId=${publicCoupon.id}`,
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

	it('forwards a server-computed bulk selector after stripping raw input', async () => {
		const request = new NextRequest(
			`https://aihero.dev/api/coursebuilder/checkout/stripe?productId=product-crash-course&quantity=5&bulk=true&cancelUrl=%2F&couponId=${bulkMerchantCoupon.id}`,
			{ method: 'POST' },
		)

		const protectedRequest = await protect(request, {
			serverComputedMerchantCoupon: bulkMerchantCoupon,
		})

		expect(protectedRequest.nextUrl.searchParams.getAll('couponId')).toEqual([
			bulkMerchantCoupon.id,
		])
	})

	it('pins the checkout country when PPP was not selected', async () => {
		const request = new NextRequest(
			`https://aihero.dev/api/coursebuilder/checkout/stripe?productId=product-crash-course&quantity=1&cancelUrl=%2F&couponId=${publicMerchantCoupon.id}&usedCouponId=${publicCoupon.id}`,
			{ method: 'POST', headers: { 'x-vercel-ip-country': 'CZ' } },
		)

		const protectedRequest = await protect(request)

		expect(protectedRequest.nextUrl.searchParams.get('country')).toBe('US')
		expect(protectedRequest.nextUrl.searchParams.get('couponId')).toBe(
			publicMerchantCoupon.id,
		)
	})

	it('keeps the real country for an upgrade without a PPP selection', async () => {
		const request = new NextRequest(
			'https://aihero.dev/api/coursebuilder/checkout/stripe?productId=product-crash-course&quantity=1&cancelUrl=%2F&upgradeFromPurchaseId=purchase-1',
			{ method: 'POST', headers: { 'x-vercel-ip-country': 'CZ' } },
		)

		const protectedRequest = await protect(request)

		expect(protectedRequest.nextUrl.searchParams.getAll('country')).toEqual([])
	})

	it('withholds a server-computed PPP selector when PPP was not selected', async () => {
		const request = new NextRequest(
			`https://aihero.dev/api/coursebuilder/checkout/stripe?productId=product-crash-course&quantity=1&cancelUrl=%2F&couponId=${protectedMerchantCoupon.id}`,
			{ method: 'POST', headers: { 'x-vercel-ip-country': 'CZ' } },
		)

		const protectedRequest = await protect(request, {
			serverComputedMerchantCoupon: pppMerchantCoupon,
		})

		expect(protectedRequest.nextUrl.searchParams.has('couponId')).toBe(false)
		expect(protectedRequest.nextUrl.searchParams.get('country')).toBe('US')
	})

	it('strips raw PPP until server pricing revalidates it', async () => {
		const request = new NextRequest(
			`https://aihero.dev/api/coursebuilder/checkout/stripe?productId=product-crash-course&quantity=1&cancelUrl=%2F&couponId=${pppMerchantCoupon.id}`,
			{ method: 'POST' },
		)

		const protectedRequest = await protect(request)

		expect(protectedRequest.nextUrl.searchParams.has('couponId')).toBe(false)
	})

	it('ignores forged caller country when server pricing reselects PPP', async () => {
		const resolveServerComputedMerchantCoupon = vi.fn(
			async () => pppMerchantCoupon,
		)
		const request = new NextRequest(
			`https://aihero.dev/api/coursebuilder/checkout/stripe?productId=product-crash-course&quantity=1&country=IN&cancelUrl=%2F&couponId=${pppMerchantCoupon.id}`,
			{
				method: 'POST',
				headers: { 'x-vercel-ip-country': 'US' },
			},
		)

		const protectedRequest = await protectCourseBuilderRequest(request, {
			adapter: createAdapter() as never,
			resolveServerComputedMerchantCoupon,
		})

		expect(resolveServerComputedMerchantCoupon).toHaveBeenCalledWith(
			expect.objectContaining({ country: 'US' }),
		)
		expect(protectedRequest.nextUrl.searchParams.getAll('country')).toEqual([])
		expect(protectedRequest.nextUrl.searchParams.get('couponId')).toBe(
			pppMerchantCoupon.id,
		)
	})

	it.each([
		['IN', 'DE'],
		['DE', 'IN'],
	])(
		'removes divergent duplicate country values %s then %s before legacy parsing',
		async (firstCountry, lastCountry) => {
			const resolveServerComputedMerchantCoupon = vi.fn(
				async () => pppMerchantCoupon,
			)
			const url = new URL(
				'https://aihero.dev/api/coursebuilder/checkout/stripe',
			)
			url.searchParams.set('productId', 'product-crash-course')
			url.searchParams.set('quantity', '1')
			url.searchParams.append('country', firstCountry)
			url.searchParams.append('country', lastCountry)
			url.searchParams.set('cancelUrl', '/')
			url.searchParams.set('couponId', pppMerchantCoupon.id)

			const protectedRequest = await protectCourseBuilderRequest(
				new NextRequest(url, {
					method: 'POST',
					headers: { 'x-vercel-ip-country': 'CA' },
				}),
				{
					adapter: createAdapter() as never,
					resolveServerComputedMerchantCoupon,
				},
			)

			expect(resolveServerComputedMerchantCoupon).toHaveBeenCalledWith(
				expect.objectContaining({ country: 'CA' }),
			)
			expect(protectedRequest.nextUrl.searchParams.getAll('country')).toEqual(
				[],
			)
		},
	)

	it('forwards PPP selected again by server pricing', async () => {
		const request = new NextRequest(
			`https://aihero.dev/api/coursebuilder/checkout/stripe?productId=product-crash-course&quantity=1&cancelUrl=%2F&couponId=${pppMerchantCoupon.id}`,
			{ method: 'POST' },
		)

		const protectedRequest = await protect(request, {
			serverComputedMerchantCoupon: pppMerchantCoupon,
		})

		expect(protectedRequest.nextUrl.searchParams.getAll('couponId')).toEqual([
			pppMerchantCoupon.id,
		])
	})

	it.each([publicMerchantCoupon, bulkMerchantCoupon])(
		'strips a raw $type selector so the server can recompute pricing',
		async (merchantCoupon) => {
			const request = new NextRequest(
				`https://aihero.dev/api/coursebuilder/checkout/stripe?productId=product-crash-course&quantity=5&bulk=true&cancelUrl=%2F&couponId=${merchantCoupon.id}`,
				{ method: 'POST' },
			)

			const protectedRequest = await protect(request)

			expect(protectedRequest.nextUrl.searchParams.has('couponId')).toBe(false)
			expect(protectedRequest.nextUrl.searchParams.get('quantity')).toBe('5')
			expect(protectedRequest.nextUrl.searchParams.get('bulk')).toBe('true')
		},
	)
})
