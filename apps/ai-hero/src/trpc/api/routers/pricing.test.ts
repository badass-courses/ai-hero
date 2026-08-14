import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
	const protectedMerchantCoupon = {
		id: 'merchant-prior-credit',
		identifier: 'stripe-prior-credit',
		merchantAccountId: 'merchant-account',
		type: 'special credit',
		status: 1,
		amountDiscount: 20_000,
		percentageDiscount: null,
	}
	const defaultMerchantCoupon = {
		id: 'merchant-intro',
		identifier: 'stripe-intro',
		merchantAccountId: 'merchant-account',
		type: 'special',
		status: 1,
		amountDiscount: 10_000,
		percentageDiscount: null,
	}
	const protectedCoupon = {
		id: 'coupon-prior-credit',
		merchantCouponId: protectedMerchantCoupon.id,
		restrictedToProductId: 'product-crash-course',
		fields: { exclusive: true },
	}
	const defaultCoupon = {
		id: 'coupon-intro',
		merchantCouponId: defaultMerchantCoupon.id,
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
	const getEntitlementsForUser = vi.fn()
	const adapter = {
		getMerchantCoupon: vi.fn(
			async (id: string) =>
				[protectedMerchantCoupon, defaultMerchantCoupon].find(
					(coupon) => coupon.id === id,
				) ?? null,
		),
		getCoupon: vi.fn(
			async (id: string) =>
				[protectedCoupon, defaultCoupon].find((coupon) => coupon.id === id) ??
				null,
		),
		getEntitlementTypeByName: vi.fn(async () => ({
			id: 'entitlement-type-special-credit',
		})),
		getEntitlementsForUser,
		getPurchasesForUser: vi.fn(async () => []),
		availableUpgradesForProduct: vi.fn(async () => []),
		getPriceForProduct: vi.fn(async () => ({ unitAmount: 299 })),
		getDefaultCoupon: vi.fn(async () => ({
			defaultCoupon,
			defaultMerchantCoupon,
		})),
		couponForIdOrCode: vi.fn(async () => null),
	}

	return {
		adapter,
		defaultMerchantCoupon,
		entitlement,
		formatPricesForProduct: vi.fn(),
		getEntitlementsForUser,
		getServerAuthSession: vi.fn(),
		protectedMerchantCoupon,
	}
})

vi.mock('@/db', () => ({
	courseBuilderAdapter: mocks.adapter,
	db: {
		query: {
			entitlementTypes: {
				findFirst: vi.fn(async () => ({
					id: 'entitlement-type-special-credit',
				})),
			},
			products: { findMany: vi.fn() },
		},
	},
}))
vi.mock('@/db/schema', () => ({ entitlementTypes: { name: 'name' } }))
vi.mock('@/server/auth', () => ({
	getServerAuthSession: mocks.getServerAuthSession,
}))
vi.mock('next/headers', () => ({
	headers: vi.fn(async () => new Headers({ 'x-vercel-ip-country': 'US' })),
}))
vi.mock('drizzle-orm', () => ({ eq: vi.fn(() => true) }))
vi.mock('@coursebuilder/core', () => ({
	formatPricesForProduct: mocks.formatPricesForProduct,
}))
vi.mock('@coursebuilder/core/pricing/props-for-commerce', () => ({
	propsForCommerce: vi.fn(),
}))

import { pricingRouter } from './pricing'

const caller = () =>
	pricingRouter.createCaller({
		db: null,
		session: null,
		ability: null,
		headers: new Headers(),
	} as never)

const formattedInput = {
	productId: 'product-crash-course',
	quantity: 1,
	merchantCoupon: {
		id: mocks.protectedMerchantCoupon.id,
		type: mocks.protectedMerchantCoupon.type,
	},
}

describe('pricing.formatted exclusive coupon authorization', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.formatPricesForProduct.mockImplementation(async (input) => ({
			id: input.productId,
			calculatedPrice:
				input.merchantCouponId === mocks.protectedMerchantCoupon.id ? 99 : 199,
			appliedMerchantCoupon:
				input.merchantCouponId === mocks.protectedMerchantCoupon.id
					? mocks.protectedMerchantCoupon
					: mocks.defaultMerchantCoupon,
		}))
	})

	it('falls back to the $199 default for a logged-out replay', async () => {
		mocks.getServerAuthSession.mockResolvedValue({ session: null })
		mocks.getEntitlementsForUser.mockResolvedValue([])

		const result = await caller().formatted(formattedInput)

		expect(result.calculatedPrice).toBe(199)
		expect(mocks.formatPricesForProduct).toHaveBeenCalledWith(
			expect.objectContaining({
				merchantCouponId: mocks.defaultMerchantCoupon.id,
				userId: undefined,
			}),
		)
	})

	it('falls back to the $199 default for a non-entitled session user', async () => {
		mocks.getServerAuthSession.mockResolvedValue({
			session: { user: { id: 'user-not-entitled' } },
		})
		mocks.getEntitlementsForUser.mockResolvedValue([])

		const result = await caller().formatted(formattedInput)

		expect(result.calculatedPrice).toBe(199)
		expect(mocks.formatPricesForProduct).toHaveBeenCalledWith(
			expect.objectContaining({
				merchantCouponId: mocks.defaultMerchantCoupon.id,
				userId: 'user-not-entitled',
			}),
		)
	})

	it('preserves the $99 path for the entitled session user', async () => {
		mocks.getServerAuthSession.mockResolvedValue({
			session: { user: { id: mocks.entitlement.userId } },
		})
		mocks.getEntitlementsForUser.mockResolvedValue([mocks.entitlement])

		const result = await caller().formatted(formattedInput)

		expect(result.calculatedPrice).toBe(99)
		expect(mocks.formatPricesForProduct).toHaveBeenCalledWith(
			expect.objectContaining({
				merchantCouponId: mocks.protectedMerchantCoupon.id,
				userId: mocks.entitlement.userId,
			}),
		)
	})
})
