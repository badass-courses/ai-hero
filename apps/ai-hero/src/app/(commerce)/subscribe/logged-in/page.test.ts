import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
	const merchantCoupon = {
		id: 'merchant-prior-credit',
		type: 'special credit',
	}
	const coupon = {
		id: 'coupon-prior-credit',
		merchantCouponId: merchantCoupon.id,
		restrictedToProductId: 'product-crash-course',
		fields: { exclusive: true },
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
		merchantCoupon,
		redirect: vi.fn((url: string) => url),
	}
})

vi.mock('@/coursebuilder/stripe-provider', () => ({
	stripeProvider: { createCheckoutSession: mocks.createCheckoutSession },
}))
vi.mock('@/db', () => ({
	courseBuilderAdapter: {
		getMerchantCoupon: vi.fn(async (id: string) =>
			id === mocks.merchantCoupon.id ? mocks.merchantCoupon : null,
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
	headers: vi.fn(async () => new Headers()),
}))
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }))
vi.mock('@coursebuilder/core/lib/checkout-attribution', () => ({
	buildCheckoutAttribution: vi.fn(() => ({})),
}))

import LoginPage from './page'

const searchParams = {
	productId: 'product-crash-course',
	quantity: '1',
	bulk: 'false',
	cancelUrl: '/',
	couponId: mocks.merchantCoupon.id,
	usedCouponId: mocks.coupon.id,
	userId: 'user-forged',
}

describe('logged-in checkout coupon authorization', () => {
	beforeEach(() => {
		vi.clearAllMocks()
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
})
