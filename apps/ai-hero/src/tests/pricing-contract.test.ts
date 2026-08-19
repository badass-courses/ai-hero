import type Stripe from 'stripe'
import { describe, expect, it, vi } from 'vitest'

import { createCheckoutLoginHandoff } from '@/lib/checkout-login-handoff'
import { resolveLoggedInCheckoutPricing } from '@/lib/logged-in-checkout-pricing'

import { formatPricesForProduct } from '@coursebuilder/core'
import {
	MockCourseBuilderAdapter,
	type CourseBuilderAdapter,
} from '@coursebuilder/core/adapters'
import { stripeCheckout } from '@coursebuilder/core/pricing/stripe-checkout'
import { StripePaymentAdapter } from '@coursebuilder/core/providers/stripe'
import type {
	PaymentsAdapter,
	PaymentsProviderConsumerConfig,
} from '@coursebuilder/core/types'

const PRODUCT_ID = 'product_ai_coding_crash_course'
const USER_ID = 'user_contract'
const DEFAULT_SITE_COUPON_ID = 'coupon_intro_100'
const DEFAULT_MERCHANT_COUPON_ID = 'merchant_intro_100'
const CREDIT_SITE_COUPON_ID = 'coupon_alumni_credit_200'

const product = {
	id: PRODUCT_ID,
	name: 'AI Coding Crash Course',
	status: 1,
	type: 'self-paced',
	createdAt: new Date('2026-08-01T00:00:00.000Z'),
}

const price = {
	id: 'price_ai_coding_crash_course',
	productId: PRODUCT_ID,
	unitAmount: 299,
	status: 1,
	createdAt: new Date('2026-08-01T00:00:00.000Z'),
}

const defaultMerchantCoupon = {
	id: DEFAULT_MERCHANT_COUPON_ID,
	identifier: 'stripe_intro_100',
	amountDiscount: 10000,
	type: 'special',
	status: 1,
	merchantAccountId: 'merchant_ai_hero',
}

const defaultSiteCoupon = {
	id: DEFAULT_SITE_COUPON_ID,
	code: 'INTRO100',
	merchantCouponId: DEFAULT_MERCHANT_COUPON_ID,
	status: 0,
	fields: { stackable: true },
	maxUses: -1,
	default: true,
	usedCount: 0,
	createdAt: new Date('2026-08-01T00:00:00.000Z'),
	percentageDiscount: 0,
	amountDiscount: 10000,
	expires: null,
	bulkPurchases: [],
	redeemedBulkCouponPurchases: [],
	restrictedToProductId: PRODUCT_ID,
	bulkPurchaseId: null,
	organizationId: null,
}

const pppTiers = [
	{ country: 'CZ', percentage: 0.4, total: 179.4 },
	{ country: 'BZ', percentage: 0.45, total: 164.45 },
	{ country: 'BH', percentage: 0.5, total: 149.5 },
	{ country: 'AM', percentage: 0.55, total: 134.55 },
	{ country: 'AL', percentage: 0.6, total: 119.6 },
	{ country: 'BJ', percentage: 0.65, total: 104.65 },
	{ country: 'TH', percentage: 0.65, total: 104.65 },
	{ country: 'AR', percentage: 0.7, total: 89.7 },
	{ country: 'TR', percentage: 0.7, total: 89.7 },
	{ country: 'AF', percentage: 0.75, total: 74.75 },
] as const

const pppCoupons: ReadonlyMap<
	number,
	{
		id: string
		identifier: string
		percentageDiscount: number
		type: 'ppp'
		status: number
		merchantAccountId: string
	}
> = new Map(
	pppTiers.map(({ percentage }) => [
		percentage,
		{
			id: `merchant_ppp_${percentage * 100}`,
			identifier: `stripe_ppp_${percentage * 100}`,
			percentageDiscount: percentage,
			type: 'ppp',
			status: 1,
			merchantAccountId: 'merchant_ai_hero',
		},
	]),
)

type Credit =
	| { kind: 'none' }
	| { kind: 'irrelevant'; amount: 3700 | 4500 }
	| { kind: 'exclusive'; amount: 19000 | 20000 }
	| { kind: 'ordinary'; amount: 2000 | 20000 }

function creditRecords(credit: Credit) {
	if (credit.kind === 'none') return null

	const exclusive = credit.kind === 'exclusive'
	const siteCoupon = {
		...defaultSiteCoupon,
		id: exclusive ? CREDIT_SITE_COUPON_ID : `coupon_${credit.kind}_${credit.amount}`,
		code: 'CREDIT',
		merchantCouponId: exclusive
			? 'merchant_alumni_credit_200'
			: `merchant_${credit.kind}_${credit.amount}`,
		fields: exclusive ? { exclusive: true } : { stackable: true },
		default: false,
		amountDiscount: credit.amount,
		restrictedToProductId:
			credit.kind === 'irrelevant' ? 'other_product' : PRODUCT_ID,
	}
	const merchantCoupon = {
		id: siteCoupon.merchantCouponId,
		identifier: `stripe_${credit.kind}_${credit.amount}`,
		amountDiscount: credit.amount,
		type: 'special',
		status: 1,
		merchantAccountId: 'merchant_ai_hero',
	}

	return { siteCoupon, merchantCoupon }
}

function createAppAdapter({
	credit = { kind: 'none' },
	purchaseStatus = 'Restricted',
}: {
	credit?: Credit
	purchaseStatus?: 'Restricted' | 'Valid'
} = {}): CourseBuilderAdapter {
	const records = creditRecords(credit)

	return {
		...MockCourseBuilderAdapter,
		getProduct: vi.fn(async () => product as never),
		getPriceForProduct: vi.fn(async () => price as never),
		getPurchase: vi.fn(async () => null),
		getPurchasesForUser: vi.fn(async (userId?: string) =>
			userId
				? ([
						{
							id: 'purchase_prior',
							userId,
							productId: 'product_prior',
							merchantChargeId: 'charge_prior',
							merchantAccountId: 'merchant_ai_hero',
							status: purchaseStatus,
							totalAmount: 40,
							createdAt: new Date('2026-01-01T00:00:00.000Z'),
							fields: {},
						},
					] as never)
				: [],
		),
		getUser: vi.fn(
			async (id: string) =>
				({
					id,
					email: 'learner@example.test',
				}) as never,
		),
		getMerchantCustomerForUserId: vi.fn(async () => ({
			id: 'merchant_customer_contract',
			identifier: 'cus_contract',
		} as never)),
		getMerchantProductForProductId: vi.fn(async () => ({
			id: 'merchant_product_contract',
			identifier: 'prod_stripe_contract',
			productId: PRODUCT_ID,
			merchantAccountId: 'merchant_ai_hero',
			status: 1,
			createdAt: new Date('2026-08-01T00:00:00.000Z'),
		} as never)),
		getMerchantPriceForProductId: vi.fn(async () => ({
			id: 'merchant_price_contract',
			identifier: 'price_stripe_contract',
			merchantProductId: 'merchant_product_contract',
			status: 1,
			priceId: price.id,
			createdAt: new Date('2026-08-01T00:00:00.000Z'),
		} as never)),
		getDefaultCoupon: vi.fn(async () => ({
			defaultMerchantCoupon: defaultMerchantCoupon as never,
			defaultCoupon: defaultSiteCoupon as never,
		})),
		getEntitlementTypeByName: vi.fn(async () => ({
			id: 'entitlement_type_credit',
			name: 'apply_special_credit',
		})),
		getEntitlementsForUser: vi.fn(async () =>
			records
				? ([
						{
							id: 'entitlement_credit',
							userId: USER_ID,
							sourceType: 'COUPON',
							sourceId: records.siteCoupon.id,
							entitlementType: 'entitlement_type_credit',
							metadata: {},
						},
					] as never)
				: [],
		),
		getCoupon: vi.fn(async (id: string) => {
			if (id === DEFAULT_SITE_COUPON_ID) return defaultSiteCoupon as never
			if (records && id === records.siteCoupon.id) {
				return records.siteCoupon as never
			}
			return null
		}),
		getMerchantCoupon: vi.fn(async (id: string) => {
			if (id === DEFAULT_MERCHANT_COUPON_ID) {
				return defaultMerchantCoupon as never
			}
			if (records && id === records.merchantCoupon.id) {
				return records.merchantCoupon as never
			}
			return (
				(Array.from(pppCoupons.values()).find((coupon) => coupon.id === id) as never) ||
				null
			)
		}),
		getMerchantCouponsForTypeAndPercent: vi.fn(
			async ({ type, percentageDiscount }) =>
				type === 'ppp' && pppCoupons.has(percentageDiscount)
					? ([pppCoupons.get(percentageDiscount)] as never)
					: [],
		),
		getMerchantCouponForTypeAndAmount: vi.fn(async () => null),
		createMerchantCoupon: vi.fn(async () => ({ id: 'merchant_stacked' }) as never),
	} as unknown as CourseBuilderAdapter
}

function providerSession(params: Stripe.Checkout.SessionCreateParams) {
	const subtotal = Number(params.metadata?.subtotalCents)
	const total = Number(params.metadata?.expectedTotalCents)
	return {
		id: 'cs_contract',
		url: 'https://checkout.stripe.test/cs_contract',
		amount_subtotal: subtotal,
		amount_total: total,
		total_details: {
			amount_discount: subtotal - total,
			amount_shipping: 0,
			amount_tax: 0,
		},
		metadata: params.metadata,
		mode: 'payment',
		status: 'open',
	} as Stripe.Checkout.Session
}

function createPaymentsAdapter() {
	const createPromotionCode = vi.fn(
		async (_params: Stripe.PromotionCodeCreateParams) => 'promo_contract',
	)
	const createCoupon = vi.fn(
		async (_params: Stripe.CouponCreateParams) => 'stripe_stacked_contract',
	)
	const createCheckoutSession = vi.fn(
		async (params: Stripe.Checkout.SessionCreateParams) => providerSession(params),
	)
	const expireCheckoutSession = vi.fn(
		async (id: string) => ({ id, status: 'expired' }) as Stripe.Checkout.Session,
	)

	const adapter: PaymentsAdapter = {
		getCouponPercentOff: vi.fn(async (identifier: string) => {
			return (
				Array.from(pppCoupons.values()).find(
					(coupon) => coupon.identifier === identifier,
				)?.percentageDiscount ?? 0
			)
		}),
		getCouponAmountOff: vi.fn(async () => 0),
		createCoupon,
		createPromotionCode,
		createCheckoutSession,
		expireCheckoutSession,
		getCheckoutSession: vi.fn(async () => providerSession({
			metadata: { subtotalCents: '29900', expectedTotalCents: '29900' },
		} as Stripe.Checkout.SessionCreateParams)),
		createCustomer: vi.fn(async () => 'cus_contract'),
		verifyWebhookSignature: vi.fn(async () => true),
		getCustomer: vi.fn(async () => ({ id: 'cus_contract' }) as never),
		updateCustomer: vi.fn(async () => undefined),
		refundCharge: vi.fn(async () => ({}) as never),
		getProduct: vi.fn(async () => ({}) as never),
		getPrice: vi.fn(async (id: string) => ({
			id,
			unit_amount: 29900,
			currency: 'usd',
			recurring: null,
		}) as never),
		updateProduct: vi.fn(async () => undefined),
		updatePrice: vi.fn(async () => undefined),
		createPrice: vi.fn(async () => ({}) as never),
		createProduct: vi.fn(async () => ({}) as never),
		getSubscription: vi.fn(async () => ({}) as never),
		getBillingPortalUrl: vi.fn(async () => 'https://example.test/billing'),
		updateSubscriptionItemQuantity: vi.fn(async () => ({}) as never),
	}

	return {
		adapter,
		createPromotionCode,
		createCoupon,
		createCheckoutSession,
		expireCheckoutSession,
	}
}

function checkoutConfig(
	paymentsAdapter: PaymentsAdapter,
): PaymentsProviderConsumerConfig {
	return {
		baseSuccessUrl: 'https://www.aihero.dev',
		cancelUrl: 'https://www.aihero.dev/cancel',
		errorRedirectUrl: 'https://www.aihero.dev/checkout-error',
		paymentsAdapter,
	}
}

async function checkout({
	country,
	credit = { kind: 'none' },
	purchaseStatus = 'Restricted',
	user = true,
	couponId,
	appAdapter,
}: {
	country: string
	credit?: Credit
	purchaseStatus?: 'Restricted' | 'Valid'
	user?: boolean
	couponId?: string
	appAdapter?: CourseBuilderAdapter
}) {
	const payments = createPaymentsAdapter()
	const result = await stripeCheckout({
		params: {
			productId: PRODUCT_ID,
			...(user && { userId: USER_ID }),
			country,
			quantity: 1,
			bulk: false,
			cancelUrl: 'https://www.aihero.dev/cancel',
			...(couponId && { couponId }),
		},
		config: checkoutConfig(payments.adapter),
		adapter: appAdapter ?? createAppAdapter({ credit, purchaseStatus }),
	})
	const payload = payments.createCheckoutSession.mock.calls[0]?.[0]

	return { payments, payload, result }
}

describe('@coursebuilder/core 2.0.3 AI Hero pricing contract', () => {
	it('keeps the public intro checkout at $199', async () => {
		const { payments, payload, result } = await checkout({
			country: 'US',
			user: false,
		})

		expect(payload?.metadata).toMatchObject({
			expectedTotalCents: '19900',
			pricingCandidate: 'sale',
			provenanceIds: DEFAULT_MERCHANT_COUPON_ID,
		})
		expect(payments.createPromotionCode).toHaveBeenCalledWith(
			expect.objectContaining({ coupon: defaultMerchantCoupon.identifier }),
		)
		expect(result).toEqual({
			redirect: 'https://checkout.stripe.test/cs_contract',
			status: 303,
		})
	})

	it.each(pppTiers)(
		'selects $percentage PPP in $country and carries matching provider provenance',
		async ({ country, percentage, total }) => {
			const { payments, payload } = await checkout({ country })
			const pppCoupon = pppCoupons.get(percentage)!

			expect(payload?.metadata).toMatchObject({
				expectedTotalCents: String(Math.round(total * 100)),
				pricingCandidate: 'ppp',
				provenanceIds: pppCoupon.id,
			})
			expect(payments.createPromotionCode).toHaveBeenCalledWith(
				expect.objectContaining({ coupon: pppCoupon.identifier }),
			)
			expect(payload?.discounts).toEqual([
				{ promotion_code: 'promo_contract' },
			])
		},
	)

	it.each([
		{ country: 'AR', amount: 3700 as const, total: 89.7 },
		{ country: 'AF', amount: 4500 as const, total: 74.75 },
	])(
		'ignores an irrelevant $amount-cent credit and keeps $country PPP at $total',
		async ({ country, amount, total }) => {
			const { payload } = await checkout({
				country,
				credit: { kind: 'irrelevant', amount },
			})

			expect(payload?.metadata).toMatchObject({
				expectedTotalCents: String(Math.round(total * 100)),
				pricingCandidate: 'ppp',
			})
			expect(payload?.metadata?.usedEntitlementCouponIds).toBeUndefined()
		},
	)

	it('uses the exclusive alumni credit when PPP is above $99', async () => {
		const { payload } = await checkout({
			country: 'AL',
			credit: { kind: 'exclusive', amount: 20000 },
		})

		expect(payload?.metadata).toMatchObject({
			expectedTotalCents: '9900',
			pricingCandidate: 'credit',
			usedEntitlementCouponIds: CREDIT_SITE_COUPON_ID,
		})
		expect(payload?.metadata?.provenanceIds).toContain(CREDIT_SITE_COUPON_ID)
	})

	it.each([
		{ country: 'TR', alumniCredit: 20000 as const, totalCents: '8970' },
		{ country: 'TH', alumniCredit: 19000 as const, totalCents: '10465' },
	])(
		'uses lower $country PPP instead of the higher alumni price',
		async ({ country, alumniCredit, totalCents }) => {
			const { payload } = await checkout({
				country,
				credit: { kind: 'exclusive', amount: alumniCredit },
			})

			expect(payload?.metadata).toMatchObject({
				expectedTotalCents: totalCents,
				pricingCandidate: 'ppp',
			})
			expect(payload?.metadata?.usedEntitlementCouponIds).toBeUndefined()
		},
	)

	it('joins a signed Turkey login handoff to real coupon resolution and restricted checkout metadata', async () => {
		const now = new Date('2026-08-19T20:00:00.000Z')
		const secret = 'test-checkout-handoff-secret'
		const pppCoupon = pppCoupons.get(0.7)!
		const appAdapter = createAppAdapter({
			credit: { kind: 'exclusive', amount: 20000 },
		})
		const checkoutHandoffToken = createCheckoutLoginHandoff({
			secret,
			country: 'TR',
			pppSelected: true,
			productId: PRODUCT_ID,
			quantity: 1,
			nonce: 'nonce-pricing-contract',
			now,
		})

		const pricing = await resolveLoggedInCheckoutPricing({
			adapter: appAdapter,
			verifiedUserId: USER_ID,
			checkoutParams: {
				productId: PRODUCT_ID,
				quantity: 1,
				country: 'TR',
				couponId: pppCoupon.id,
			},
			checkoutHandoffToken,
			trustedCountry: 'US',
			handoffSecret: secret,
			now: new Date('2026-08-19T20:05:00.000Z'),
		})

		expect(pricing.checkoutHandoff).toMatchObject({ valid: true })
		expect(pricing.couponAuthorization).toMatchObject({
			authorized: false,
			requestedPPP: true,
		})
		expect(pricing).toMatchObject({
			country: 'TR',
			couponId: pppCoupon.id,
			usedCouponId: undefined,
		})

		const { payload } = await checkout({
			country: pricing.country,
			credit: { kind: 'exclusive', amount: 20000 },
			couponId: pricing.couponId,
			appAdapter,
		})
		expect(payload?.metadata).toMatchObject({
			country: 'TR',
			expectedTotalCents: '8970',
			pricingCandidate: 'ppp',
			provenanceIds: pppCoupon.id,
		})
		expect(payload?.metadata?.appliedPPPStripeCouponId).toBeTruthy()
		expect(payload?.metadata?.usedEntitlementCouponIds).toBeUndefined()
	})

	it('uses the current $99 alumni policy instead of Thailand PPP at $104.65', async () => {
		const { payload } = await checkout({
			country: 'TH',
			credit: { kind: 'exclusive', amount: 20000 },
		})

		expect(payload?.metadata).toMatchObject({
			country: 'TH',
			expectedTotalCents: '9900',
			pricingCandidate: 'credit',
			usedEntitlementCouponIds: CREDIT_SITE_COUPON_ID,
		})
		expect(payload?.metadata?.provenanceIds).toContain(CREDIT_SITE_COUPON_ID)
	})

	it('uses the alumni credit where PPP is unavailable', async () => {
		const { payload } = await checkout({
			country: 'US',
			credit: { kind: 'exclusive', amount: 20000 },
		})

		expect(payload?.metadata).toMatchObject({
			expectedTotalCents: '9900',
			pricingCandidate: 'credit',
			usedEntitlementCouponIds: CREDIT_SITE_COUPON_ID,
		})
	})

	it('preserves supported intro-sale plus ordinary-credit stacking', async () => {
		const { payments, payload } = await checkout({
			country: 'US',
			credit: { kind: 'ordinary', amount: 2000 },
		})

		expect(payload?.metadata).toMatchObject({
			expectedTotalCents: '17900',
			pricingCandidate: 'credit',
			usedEntitlementCouponIds: 'coupon_ordinary_2000',
		})
		expect(payments.createCoupon).toHaveBeenCalledWith(
			expect.objectContaining({ amount_off: 12000 }),
		)
		expect(payload?.discounts).toEqual([
			{ promotion_code: 'promo_contract' },
		])
	})

	it('refuses an accidental non-positive paid checkout before provider creation', async () => {
		const adapter = createAppAdapter({
			credit: { kind: 'ordinary', amount: 20000 },
		})
		await expect(
			formatPricesForProduct({
				ctx: adapter,
				productId: PRODUCT_ID,
				userId: USER_ID,
				country: 'US',
				quantity: 1,
				merchantCouponId: DEFAULT_MERCHANT_COUPON_ID,
				usedCouponId: DEFAULT_SITE_COUPON_ID,
				preferStacking: true,
				autoApplyPPP: true,
			}),
		).rejects.toThrow('pricing-total-not-positive')

		const payments = createPaymentsAdapter()
		const result = await stripeCheckout({
			params: {
				productId: PRODUCT_ID,
				userId: USER_ID,
				country: 'US',
				quantity: 1,
				bulk: false,
				cancelUrl: 'https://www.aihero.dev/cancel',
			},
			config: checkoutConfig(payments.adapter),
			adapter,
		})

		expect(result).toEqual({
			redirect: 'https://www.aihero.dev/checkout-error',
			status: 303,
		})
		expect(payments.createCheckoutSession).not.toHaveBeenCalled()
	})

	it('ships the changed PaymentsAdapter seam on StripePaymentAdapter', () => {
		const create: PaymentsAdapter['createCheckoutSession'] =
			StripePaymentAdapter.prototype.createCheckoutSession
		const expire: PaymentsAdapter['expireCheckoutSession'] =
			StripePaymentAdapter.prototype.expireCheckoutSession

		expect(typeof create).toBe('function')
		expect(typeof expire).toBe('function')
	})
})
