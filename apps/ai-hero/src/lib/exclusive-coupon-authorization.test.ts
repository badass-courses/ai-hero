import { describe, expect, it } from 'vitest'

import { authorizeExclusiveCouponSelection } from './exclusive-coupon-authorization'

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
const pppMerchantCoupon = { id: 'merchant-ppp', type: 'ppp', status: 1 }
const deniedMerchantCoupons = [
	{ id: 'merchant-special', type: 'special', status: 1 },
	{ id: 'merchant-bulk', type: 'bulk', status: 1 },
	{ id: 'merchant-stacked', type: 'stacked', status: 1 },
	{ id: 'merchant-upgrade', type: 'upgrade', status: 1 },
	{ id: 'merchant-credit-bulk', type: 'special credit bulk', status: 1 },
]

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
const wrongProductPublicCoupon = {
	...publicCoupon,
	id: 'coupon-public-other-product',
	restrictedToProductId: 'product-other',
}
const expiredPublicCoupon = {
	...publicCoupon,
	id: 'coupon-public-expired',
	expires: new Date('2025-01-01T00:00:00Z'),
}
const exhaustedPublicCoupon = {
	...publicCoupon,
	id: 'coupon-public-exhausted',
	maxUses: 1,
	usedCount: 1,
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

const merchantCoupons = [
	protectedMerchantCoupon,
	publicMerchantCoupon,
	pppMerchantCoupon,
	...deniedMerchantCoupons,
]
const siteCoupons = [
	protectedCoupon,
	publicCoupon,
	wrongProductPublicCoupon,
	expiredPublicCoupon,
	exhaustedPublicCoupon,
]

const createAdapter = ({
	entitlements = [],
}: {
	entitlements?: Array<typeof activeEntitlement>
} = {}) => ({
	getMerchantCoupon: async (id: string) =>
		merchantCoupons.find((coupon) => coupon.id === id) ?? null,
	getCoupon: async (id: string) =>
		siteCoupons.find((coupon) => coupon.id === id) ?? null,
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

	it('authorizes the selector from its entitled source coupon', async () => {
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

	it.each(deniedMerchantCoupons)(
		'rejects a raw $type merchant selector without site provenance',
		async (merchantCoupon) => {
			const result = await decide({
				requestedMerchantCouponId: merchantCoupon.id,
			})

			expect(result.authorized).toBe(false)
		},
	)

	it('rejects mismatched or wrong-product public provenance', async () => {
		const [mismatched, wrongProduct] = await Promise.all([
			decide({
				requestedMerchantCouponId: deniedMerchantCoupons[0]?.id,
				requestedSiteCouponId: publicCoupon.id,
			}),
			decide({
				requestedMerchantCouponId: publicMerchantCoupon.id,
				requestedSiteCouponId: wrongProductPublicCoupon.id,
			}),
		])

		expect(mismatched.authorized).toBe(false)
		expect(wrongProduct.authorized).toBe(false)
	})

	it.each([expiredPublicCoupon, exhaustedPublicCoupon])(
		'rejects raw merchant provenance from $id',
		async (siteCoupon) => {
			const result = await decide({
				requestedMerchantCouponId: publicMerchantCoupon.id,
				requestedSiteCouponId: siteCoupon.id,
				now: new Date('2026-08-14T00:00:00Z'),
			})

			expect(result.authorized).toBe(false)
		},
	)

	it('leaves a matching active public coupon compatible', async () => {
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

	it('rejects raw PPP until server pricing revalidates it', async () => {
		const result = await decide({
			requestedMerchantCouponId: pppMerchantCoupon.id,
		})

		expect(result.authorized).toBe(false)
	})

	it('rejects inactive public site input without a merchant selector', async () => {
		const result = await decide({
			requestedMerchantCouponId: undefined,
			requestedSiteCouponId: expiredPublicCoupon.id,
			now: new Date('2026-08-14T00:00:00Z'),
		})

		expect(result.authorized).toBe(false)
	})

	it('rejects an inactive merchant even with matching entitlement provenance', async () => {
		const adapter = createAdapter({ entitlements: [activeEntitlement] })
		const result = await decide({
			adapter: {
				...adapter,
				getMerchantCoupon: async () => ({
					...protectedMerchantCoupon,
					status: 0,
				}),
			} as never,
			verifiedUserId: activeEntitlement.userId,
		})

		expect(result.authorized).toBe(false)
	})
})
