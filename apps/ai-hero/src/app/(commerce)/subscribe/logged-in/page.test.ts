import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
	const merchantCoupon = {
		id: 'merchant-prior-credit',
		type: 'special credit',
		status: 1,
	}
	const pppMerchantCoupon = {
		id: 'merchant-requested-ppp',
		type: 'ppp',
		status: 1,
	}
	const inactivePppMerchantCoupon = {
		id: 'merchant-inactive-ppp',
		type: 'ppp',
		status: 0,
	}
	const coupon = {
		id: 'coupon-prior-credit',
		merchantCouponId: merchantCoupon.id,
		restrictedToProductId: 'product-crash-course',
		fields: { exclusive: true },
		status: 1,
		expires: null,
		maxUses: -1,
		usedCount: 0,
	}
	const entitlement = {
		id: 'entitlement-prior-credit',
		userId: 'user-actual',
		sourceType: 'COUPON',
		sourceId: coupon.id,
		entitlementType: 'entitlement-type-special-credit',
		deletedAt: null,
		expiresAt: null,
	}
	const getEntitlementsForUser = vi.fn()
	return {
		coupon,
		createCheckoutSession: vi.fn(async () => ({
			redirect: 'https://checkout.example/session',
		})),
		entitlement,
		getEntitlementsForUser,
		headers: vi.fn(async () => new Headers()),
		inactivePppMerchantCoupon,
		merchantCoupon,
		pppMerchantCoupon,
		redirect: vi.fn((url: string) => url),
		resolveServerComputedCheckoutCoupon: vi.fn(
			async (): Promise<{ id: string; type: string } | null> => null,
		),
	}
})

vi.mock('@/coursebuilder/server-computed-checkout-coupon', () => ({
	resolveServerComputedCheckoutCoupon:
		mocks.resolveServerComputedCheckoutCoupon,
}))
vi.mock('@/coursebuilder/stripe-provider', () => ({
	stripeProvider: { createCheckoutSession: mocks.createCheckoutSession },
}))
vi.mock('@/db', () => ({
	courseBuilderAdapter: {
		getMerchantCoupon: vi.fn(async (id: string) =>
			[
				mocks.merchantCoupon,
				mocks.pppMerchantCoupon,
				mocks.inactivePppMerchantCoupon,
			].find((coupon) => coupon.id === id) ?? null,
		),
		getCoupon: vi.fn(async (id: string) =>
			id === mocks.coupon.id ? mocks.coupon : null,
		),
		getEntitlementTypeByName: vi.fn(async () => ({
			id: 'entitlement-type-special-credit',
		})),
		getEntitlementsForUser: mocks.getEntitlementsForUser,
	},
}))
vi.mock('@/lib/checkout-subscriber-attribution', () => ({
	addKitSubscriberToCheckoutAttribution: vi.fn(() => ({})),
}))
vi.mock('@/lib/subscriptions', () => ({
	getSubscriptionStatus: vi.fn(async () => ({ hasActiveSubscription: false })),
}))
vi.mock('@/server/auth', () => ({
	getServerAuthSession: vi.fn(async () => ({
		session: { user: { id: 'user-actual' } },
	})),
}))
vi.mock('next/headers', () => ({
	cookies: vi.fn(async () => ({ get: vi.fn(() => undefined) })),
	headers: mocks.headers,
}))
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }))
vi.mock('@coursebuilder/core/lib/checkout-attribution', () => ({
	buildCheckoutAttribution: vi.fn(() => ({})),
}))

import { createCheckoutLoginHandoff } from '@/lib/checkout-login-handoff'

import LoginPage from './page'

const handoffSecret = 'test_nextauth_secret'
const searchParams = {
	productId: 'product-crash-course',
	quantity: '1',
	bulk: 'false',
	cancelUrl: '/',
	couponId: mocks.merchantCoupon.id,
	usedCouponId: mocks.coupon.id,
	userId: 'user-forged',
}

const signedHandoff = ({
	country = 'TR',
	productId = searchParams.productId,
	quantity = 1,
	now = new Date(),
}: {
	country?: string
	productId?: string
	quantity?: number
	now?: Date
} = {}) =>
	createCheckoutLoginHandoff({
		secret: handoffSecret,
		country,
		pppSelected: true,
		productId,
		quantity,
		nonce: 'nonce-logged-in-test',
		now,
	})

describe('logged-in checkout coupon authorization', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.headers.mockResolvedValue(new Headers())
		mocks.resolveServerComputedCheckoutCoupon.mockResolvedValue(null)
	})

	it('removes an unowned exclusive selector before Stripe checkout', async () => {
		mocks.getEntitlementsForUser.mockResolvedValue([])

		await LoginPage({ searchParams: Promise.resolve(searchParams) })

		expect(mocks.createCheckoutSession).toHaveBeenCalledWith(
			expect.objectContaining({
				couponId: undefined,
				usedCouponId: undefined,
				userId: 'user-actual',
			}),
			expect.anything(),
		)
	})

	it('preserves the selector for its entitled owner', async () => {
		mocks.getEntitlementsForUser.mockResolvedValue([mocks.entitlement])

		await LoginPage({ searchParams: Promise.resolve(searchParams) })

		expect(mocks.createCheckoutSession).toHaveBeenCalledWith(
			expect.objectContaining({
				couponId: mocks.merchantCoupon.id,
				usedCouponId: mocks.coupon.id,
				userId: 'user-actual',
			}),
			expect.anything(),
		)
	})

	it('replaces callback provenance with the entitlement source coupon', async () => {
		mocks.getEntitlementsForUser.mockResolvedValue([mocks.entitlement])

		await LoginPage({
			searchParams: Promise.resolve({
				...searchParams,
				usedCouponId: 'coupon-untrusted',
			}),
		})

		expect(mocks.createCheckoutSession).toHaveBeenCalledWith(
			expect.objectContaining({
				couponId: mocks.merchantCoupon.id,
				usedCouponId: mocks.coupon.id,
			}),
			expect.anything(),
		)
	})

	it('forwards a server-computed bulk coupon after rejecting raw input', async () => {
		mocks.getEntitlementsForUser.mockResolvedValue([mocks.entitlement])
		mocks.resolveServerComputedCheckoutCoupon.mockResolvedValue({
			id: 'merchant-server-bulk',
			type: 'bulk',
		})

		await LoginPage({
			searchParams: Promise.resolve({ ...searchParams, quantity: '5' }),
		})

		expect(mocks.createCheckoutSession).toHaveBeenCalledWith(
			expect.objectContaining({
				couponId: 'merchant-server-bulk',
				usedCouponId: undefined,
				quantity: 5,
			}),
			expect.anything(),
		)
	})

	it('rejects the selector when checkout quantity is zero', async () => {
		mocks.getEntitlementsForUser.mockResolvedValue([mocks.entitlement])

		await LoginPage({
			searchParams: Promise.resolve({ ...searchParams, quantity: '0' }),
		})

		expect(mocks.createCheckoutSession).toHaveBeenCalledWith(
			expect.objectContaining({
				couponId: undefined,
				usedCouponId: undefined,
				quantity: 0,
			}),
			expect.anything(),
		)
	})

	it('accepts a valid signed Turkey PPP handoff', async () => {
		mocks.resolveServerComputedCheckoutCoupon.mockResolvedValue({
			id: 'merchant-server-ppp-70',
			type: 'ppp',
		})

		await LoginPage({
			searchParams: Promise.resolve({
				...searchParams,
				country: 'TR',
				couponId: mocks.pppMerchantCoupon.id,
				usedCouponId: undefined,
				checkoutHandoff: signedHandoff(),
			}),
		})

		expect(mocks.resolveServerComputedCheckoutCoupon).toHaveBeenCalledWith(
			expect.objectContaining({ country: 'TR' }),
		)
		expect(mocks.createCheckoutSession).toHaveBeenCalledWith(
			expect.objectContaining({
				country: 'TR',
				couponId: 'merchant-server-ppp-70',
				usedCouponId: undefined,
			}),
			expect.anything(),
		)
	})

	it.each([
		['a trusted US header', new Headers({ 'x-vercel-ip-country': 'US' })],
		['no country header', new Headers()],
	])(
		'does not honor forged Turkey country with %s and no valid handoff',
		async (_, callbackHeaders) => {
			mocks.headers.mockResolvedValue(callbackHeaders)

			await LoginPage({
				searchParams: Promise.resolve({
					...searchParams,
					country: 'TR',
					couponId: mocks.pppMerchantCoupon.id,
					usedCouponId: undefined,
				}),
			})

			expect(mocks.resolveServerComputedCheckoutCoupon).toHaveBeenCalledWith(
				expect.objectContaining({ country: 'US' }),
			)
			expect(mocks.createCheckoutSession).toHaveBeenCalledWith(
				expect.objectContaining({
					country: 'US',
					couponId: undefined,
				}),
				expect.anything(),
			)
		},
	)

	it('does not let an inactive PPP selector authorize the signed country', async () => {
		await LoginPage({
			searchParams: Promise.resolve({
				...searchParams,
				country: 'TR',
				couponId: mocks.inactivePppMerchantCoupon.id,
				usedCouponId: undefined,
				checkoutHandoff: signedHandoff(),
			}),
		})

		expect(mocks.resolveServerComputedCheckoutCoupon).toHaveBeenCalledWith(
			expect.objectContaining({ country: 'US' }),
		)
		expect(mocks.createCheckoutSession).toHaveBeenCalledWith(
			expect.objectContaining({ country: 'US', couponId: undefined }),
			expect.anything(),
		)
	})

	it.each([
		[
			'tampered',
			() => {
				const token = signedHandoff()
				return `${token.slice(0, -1)}${token.endsWith('a') ? 'b' : 'a'}`
			},
			{ country: 'TR', productId: searchParams.productId, quantity: '1' },
		],
		[
			'expired',
			() => signedHandoff({ now: new Date(Date.now() - 11 * 60 * 1000) }),
			{ country: 'TR', productId: searchParams.productId, quantity: '1' },
		],
		[
			'product-mismatched',
			() => signedHandoff({ productId: 'product-other' }),
			{ country: 'TR', productId: searchParams.productId, quantity: '1' },
		],
		[
			'quantity-mismatched',
			() => signedHandoff({ quantity: 2 }),
			{ country: 'TR', productId: searchParams.productId, quantity: '1' },
		],
		[
			'country-mismatched',
			() => signedHandoff({ country: 'TR' }),
			{ country: 'TH', productId: searchParams.productId, quantity: '1' },
		],
	] as const)(
		'falls back safely for a %s signed handoff',
		async (_, handoff, callbackParams) => {
			await LoginPage({
				searchParams: Promise.resolve({
					...searchParams,
					...callbackParams,
					couponId: mocks.pppMerchantCoupon.id,
					usedCouponId: undefined,
					checkoutHandoff: handoff(),
				}),
			})

			expect(mocks.resolveServerComputedCheckoutCoupon).toHaveBeenCalledWith(
				expect.objectContaining({ country: 'US' }),
			)
			expect(mocks.createCheckoutSession).toHaveBeenCalledWith(
				expect.objectContaining({ country: 'US', couponId: undefined }),
				expect.anything(),
			)
		},
	)

	it('uses the trusted callback country for an alumni-only checkout', async () => {
		mocks.getEntitlementsForUser.mockResolvedValue([mocks.entitlement])
		mocks.headers.mockResolvedValue(
			new Headers({ 'x-vercel-ip-country': 'CA' }),
		)

		await LoginPage({
			searchParams: Promise.resolve({ ...searchParams, country: 'TR' }),
		})

		expect(mocks.resolveServerComputedCheckoutCoupon).not.toHaveBeenCalled()
		expect(mocks.createCheckoutSession).toHaveBeenCalledWith(
			expect.objectContaining({
				country: 'CA',
				couponId: mocks.merchantCoupon.id,
				usedCouponId: mocks.coupon.id,
			}),
			expect.anything(),
		)
	})

	it('keeps an ineligible signed US PPP region without inventing a coupon', async () => {
		await LoginPage({
			searchParams: Promise.resolve({
				...searchParams,
				country: 'US',
				couponId: mocks.pppMerchantCoupon.id,
				usedCouponId: undefined,
				checkoutHandoff: signedHandoff({ country: 'US' }),
			}),
		})

		expect(mocks.resolveServerComputedCheckoutCoupon).toHaveBeenCalledWith(
			expect.objectContaining({ country: 'US' }),
		)
		expect(mocks.createCheckoutSession).toHaveBeenCalledWith(
			expect.objectContaining({
				country: 'US',
				couponId: undefined,
				usedCouponId: undefined,
			}),
			expect.anything(),
		)
	})
})
