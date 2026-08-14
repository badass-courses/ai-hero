import { describe, expect, it } from 'vitest'

import { authorizeExclusiveCouponSelection } from './exclusive-coupon-authorization'

const protectedMerchantCoupon = {
	id: 'merchant-prior-credit',
	type: 'special credit',
}

const publicMerchantCoupon = {
	id: 'merchant-public',
	type: 'special',
}

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

const activeEntitlement = {
	id: 'entitlement-prior-credit',
	userId: 'user-entitled',
	sourceType: 'COUPON',
	sourceId: protectedCoupon.id,
	entitlementType: 'entitlement-type-special-credit',
	deletedAt: null,
	expiresAt: null,
}

const createAdapter = ({
	entitlements = [],
}: {
	entitlements?: Array<typeof activeEntitlement>
} = {}) => ({
	getMerchantCoupon: async (id: string) =>
		[protectedMerchantCoupon, publicMerchantCoupon].find(
			(coupon) => coupon.id === id,
		) ?? null,
	getCoupon: async (id: string) =>
		[protectedCoupon, publicCoupon].find((coupon) => coupon.id === id) ?? null,
	getEntitlementTypeByName: async (name: string) =>
		name === 'apply_special_credit'
			? { id: 'entitlement-type-special-credit' }
			: null,
	getEntitlementsForUser: async ({ userId }: { userId: string }) =>
		entitlements.filter((entitlement) => entitlement.userId === userId),
})

const decide = (
	overrides: Partial<
		Parameters<typeof authorizeExclusiveCouponSelection>[0]
	> = {},
) =>
	authorizeExclusiveCouponSelection({
		adapter: createAdapter() as never,
		verifiedUserId: undefined,
		productId: 'product-crash-course',
		quantity: 1,
		requestedMerchantCouponId: protectedMerchantCoupon.id,
		...overrides,
	})

describe('authorizeExclusiveCouponSelection', () => {
	it.each([
		['logged out', undefined],
		['not entitled', 'user-other'],
	])(
		'rejects a protected merchant coupon for %s callers',
		async (_, userId) => {
			const result = await decide({ verifiedUserId: userId })

			expect(result).toMatchObject({
				authorized: false,
				protectedMerchantCoupon: true,
			})
		},
	)

	it('authorizes the selector for its entitled owner', async () => {
		const result = await decide({
			adapter: createAdapter({ entitlements: [activeEntitlement] }) as never,
			verifiedUserId: activeEntitlement.userId,
		})

		expect(result).toMatchObject({
			authorized: true,
			protectedMerchantCoupon: true,
			entitlementCouponId: protectedCoupon.id,
		})
	})

	it.each([
		['the wrong product', { productId: 'product-other' }],
		['more than one seat', { quantity: 2 }],
	])('rejects an exclusive credit for %s', async (_, input) => {
		const result = await decide({
			adapter: createAdapter({ entitlements: [activeEntitlement] }) as never,
			verifiedUserId: activeEntitlement.userId,
			...input,
		})

		expect(result.authorized).toBe(false)
	})

	it('rejects an exclusive site coupon without its entitlement', async () => {
		const result = await decide({
			requestedMerchantCouponId: undefined,
			requestedSiteCouponId: protectedCoupon.id,
		})

		expect(result).toMatchObject({
			authorized: false,
			protectedSiteCoupon: true,
		})
	})

	it('leaves an ordinary public coupon compatible', async () => {
		const result = await decide({
			requestedMerchantCouponId: publicMerchantCoupon.id,
			requestedSiteCouponId: publicCoupon.id,
		})

		expect(result).toMatchObject({
			authorized: true,
			protectedMerchantCoupon: false,
			protectedSiteCoupon: false,
		})
	})
})
