import { protectCourseBuilderRequest } from '@/coursebuilder/coursebuilder-request-authorization'
import type { PricingFacts } from '@ai-hero/front-desk-support'
import { price } from '@ai-hero/front-desk-support/pricing'
import { NextRequest } from 'next/server'
import type Stripe from 'stripe'
import { describe, expect, it, vi } from 'vitest'

import type { CommerceAdapter } from '@coursebuilder/commerce'
import { stripeCheckoutResult } from '@coursebuilder/commerce/stripe-checkout'
import { AUTHORITATIVE_PPP_OFFER_ID } from '@coursebuilder/commerce/authoritative-price'
import type { PaymentsAdapter } from '@coursebuilder/core/types'

import { C5_PRODUCT_ID, decodeDecisionRef } from './decision'
import { createC5AuthoritativePrice, type BuyerRead } from './hook'
import {
	SYNTHETIC_LEGEND_PRODUCTS,
	SYNTHETIC_LIST,
	SYNTHETIC_POLICY_VERSION,
	syntheticPolicy,
} from './synthetic-policy.test-fixture'

// A Crash Course owner whose account has an upgrade row toward C5 checks out
// through the request guard, Course Builder's checkout and the real hook.
// Synthetic policy: early new-buyer price 800.00, less a 100.00 credit.
const USER_ID = 'user-cc-owner'
const CC_PURCHASE = 'purchase-crash-course'
const PRICE_ID = 'price-c5'
const EARLY = new Date('2030-01-05T00:00:00.000Z')
const known = <A>(value: A) => ({ value, sourceRefs: ['test'] })

const owner: BuyerRead = {
	kind: 'buyer',
	email: 'owner@example.test',
	holdsRestrictedPurchase: false,
	holdsValidProductPurchase: false,
	facts: {
		product: {
			appProductId: C5_PRODUCT_ID,
			merchantPriceId: PRICE_ID,
			merchantUnit: SYNTHETIC_LIST,
			sourceRefs: ['test:product'],
		},
		buyer: { userId: USER_ID, sourceRefs: ['test:user'] },
		quantity: 1,
		facts: {
			order: known('individual' as const),
			alumni: known('none' as const),
			credit: known({ paid: 10_000, source: CC_PURCHASE }),
			creditUse: known('available' as const),
			existingSeats: known(0),
			legend: {
				value: 'no' as const,
				sourceRefs: SYNTHETIC_LEGEND_PRODUCTS.map((id) => `product:${id}`),
			},
			ppp: known(null),
		} as PricingFacts['facts'],
	},
}

const authoritativePriceFor = (buyer: BuyerRead = owner, country = 'US', percent = 0) => createC5AuthoritativePrice({
	policy: async () => ({
		ok: true as const,
		value: { version: SYNTHETIC_POLICY_VERSION, policy: syntheticPolicy() },
	}),
	quotes: async () => ({ ok: true as const, value: [] }),
	buyer: async () => buyer,
	trustedCountry: async () => country,
	pppPercent: () => percent,
	price,
	engineVersion: 'engine-test',
	now: () => EARLY,
	disabled: () => false,
})

const ccPurchase = {
	id: CC_PURCHASE,
	userId: USER_ID,
	productId: 'product-ma254',
	status: 'Valid',
	totalAmount: 100,
	createdAt: new Date('2029-01-01T00:00:00.000Z'),
	fields: {},
}

const adapter = {
	authoritativePrice: authoritativePriceFor(),
	getProduct: vi.fn(async () => ({
		id: C5_PRODUCT_ID,
		name: 'Synthetic cohort',
		status: 1,
		type: 'cohort',
		createdAt: new Date('2029-01-01T00:00:00.000Z'),
	})),
	getPriceForProduct: vi.fn(async () => ({
		id: PRICE_ID,
		productId: C5_PRODUCT_ID,
		unitAmount: SYNTHETIC_LIST / 100,
		status: 1,
		createdAt: new Date('2029-01-01T00:00:00.000Z'),
	})),
	getPurchase: vi.fn(async (id: string) => (id === CC_PURCHASE ? ccPurchase : null)),
	getPurchasesForUser: vi.fn(async () => [ccPurchase]),
	// The upgrade row toward C5 that the guard must make irrelevant.
	availableUpgradesForProduct: vi.fn(async () => [
		{ upgradableToId: C5_PRODUCT_ID, upgradableFromId: 'product-ma254' },
	]),
	getUser: vi.fn(async (id: string) => ({ id, email: 'owner@example.test' })),
	getMerchantCustomerForUserId: vi.fn(async () => ({
		id: 'merchant-customer',
		identifier: 'cus_owner',
	})),
	getMerchantProductForProductId: vi.fn(async () => ({
		id: 'merchant-product',
		identifier: 'prod_c5',
		productId: C5_PRODUCT_ID,
		merchantAccountId: 'merchant-account',
		status: 1,
		createdAt: new Date('2029-01-01T00:00:00.000Z'),
	})),
	getMerchantPriceForProductId: vi.fn(async () => ({
		id: 'merchant-price',
		identifier: 'price_c5',
		merchantProductId: 'merchant-product',
		status: 1,
		priceId: PRICE_ID,
		createdAt: new Date('2029-01-01T00:00:00.000Z'),
	})),
	getDefaultCoupon: vi.fn(async () => null),
	getCoupon: vi.fn(async () => null),
	getMerchantCoupon: vi.fn(async () => null),
	createMerchantCoupon: vi.fn(async () => ({ id: 'merchant-authoritative' })),
} as unknown as CommerceAdapter

function payments() {
	let discountCents = 0
	const createCheckoutSession = vi.fn(
		async (params: Stripe.Checkout.SessionCreateParams) => {
			// Fake Stripe computes the total from the line items and coupon, not
			// from the metadata whose agreement the checkout verifier checks.
			const subtotal = SYNTHETIC_LIST * Number(params.line_items?.[0]?.quantity ?? 1)
			const total = subtotal - (params.discounts?.length ? discountCents : 0)
			return {
				id: 'cs_c5_contract',
				url: 'https://checkout.stripe.test/cs_c5_contract',
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
		},
	)
	const paymentsAdapter = {
		getCouponPercentOff: vi.fn(async () => 0),
		getCouponAmountOff: vi.fn(async () => 0),
		createCoupon: vi.fn(async (coupon: Stripe.CouponCreateParams) => {
			discountCents = coupon.amount_off ?? 0
			return 'stripe_authoritative_coupon'
		}),
		createPromotionCode: vi.fn(async () => 'promo_c5_contract'),
		createCheckoutSession,
		expireCheckoutSession: vi.fn(),
		getCheckoutSession: vi.fn(),
		createCustomer: vi.fn(async () => 'cus_owner'),
		getCustomer: vi.fn(async () => ({ id: 'cus_owner' })),
		updateCustomer: vi.fn(),
		getPrice: vi.fn(async (id: string) => ({
			id,
			unit_amount: SYNTHETIC_LIST,
			currency: 'usd',
			recurring: null,
		})),
	} as unknown as PaymentsAdapter
	return { paymentsAdapter, createCheckoutSession }
}

/** The checkout route: guard the request, then hand its params to Course Builder. */
async function checkoutFrom(url: string, checkoutAdapter = adapter, country = 'US') {
	const guarded = await protectCourseBuilderRequest(
		new NextRequest(url, { method: 'POST', headers: { 'x-vercel-ip-country': country } }),
		{
			adapter: checkoutAdapter as never,
			verifiedUserId: USER_ID,
			authoritativeProductIds: new Set([C5_PRODUCT_ID]),
		},
	)
	const params = Object.fromEntries(guarded.nextUrl.searchParams)
	const { paymentsAdapter, createCheckoutSession } = payments()
	const result = await stripeCheckoutResult({
		params: params as never,
		config: {
			baseSuccessUrl: 'https://app.test',
			cancelUrl: 'https://app.test/cancel',
			errorRedirectUrl: 'https://app.test/error',
			paymentsAdapter,
		},
		adapter: checkoutAdapter,
		requestOptions: { trustedCountry: country },
	})
	return { params, result, paymentsAdapter, payload: createCheckoutSession.mock.calls[0]?.[0] }
}

const C5_CHECKOUT = `https://app.test/api/coursebuilder/checkout/stripe?productId=${C5_PRODUCT_ID}&quantity=1&cancelUrl=https%3A%2F%2Fapp.test%2Fc5`

describe('a Crash Course owner with an upgrade row toward C5', () => {
	it.each([
		[60, false, 55_000, 'none', CC_PURCHASE],
		[60, true, 40_000, 'region', null],
		[10, true, 55_000, 'none', CC_PURCHASE],
	] as const)('matches display to the charge for an alum with a Valid Crash Course purchase (PPP %s, accepted %s)', async (percent, accepted, total, restriction, creditSource) => {
		const alum: BuyerRead = {
			...owner,
			facts: {
				...owner.facts,
				facts: { ...owner.facts.facts, alumni: known('c4' as const) },
			},
		}
		const authoritativePrice = authoritativePriceFor(alum, 'AR', percent)
		const checkoutAdapter = { ...adapter, authoritativePrice }
		const display = await authoritativePrice({
			purpose: 'display', productId: C5_PRODUCT_ID, priceId: PRICE_ID,
			quantity: 1, userId: USER_ID, country: 'US', pppAccepted: accepted,
		})
		expect(ccPurchase.status).toBe('Valid')
		expect(display).toMatchObject({ kind: 'priced', amountCents: total, restriction })
		expect(display!.offers).toEqual(!accepted
			? [expect.objectContaining({ amountCents: 40_000, percent: 0.6, restriction: 'region' })]
			: [])
		const { result, payload, paymentsAdapter, params } = await checkoutFrom(
			`${C5_CHECKOUT}&upgradeFromPurchaseId=${CC_PURCHASE}${accepted ? `&couponId=${AUTHORITATIVE_PPP_OFFER_ID}` : ''}`,
			checkoutAdapter,
			'AR',
		)
		expect(params.upgradeFromPurchaseId).toBeUndefined()
		expect(result).toMatchObject({ kind: 'success' })
		expect(payload?.metadata).toMatchObject({
			expectedTotalCents: String(display!.amountCents),
			subtotalCents: String(SYNTHETIC_LIST),
			accessRestriction: restriction,
			country: 'AR',
		})
		expect(decodeDecisionRef(payload!.metadata!.decisionRef as string)?.creditSource).toBe(creditSource)
		// Verify the actual provider discount, not just the expected-total metadata.
		expect(paymentsAdapter.createCoupon).toHaveBeenCalledTimes(1)
		expect(paymentsAdapter.createCoupon).toHaveBeenCalledWith(expect.objectContaining({
			amount_off: SYNTHETIC_LIST - total,
			applies_to: { products: ['prod_c5'] },
		}))
		expect(payload?.discounts).toEqual([{ coupon: 'stripe_authoritative_coupon' }])
		expect(payload?.line_items).toEqual([{ price: 'price_c5', quantity: 1 }])
		expect(paymentsAdapter.getCouponPercentOff).not.toHaveBeenCalled()
	})

	it('gets the credit price and a session, not an upgrade refusal', async () => {
		const { params, result, payload } = await checkoutFrom(
			`${C5_CHECKOUT}&upgradeFromPurchaseId=${CC_PURCHASE}`,
		)
		expect(params.upgradeFromPurchaseId).toBeUndefined()
		expect(result).toMatchObject({ kind: 'success' })
		expect(payload?.metadata).toMatchObject({
			expectedTotalCents: '70000',
			policyVersion: SYNTHETIC_POLICY_VERSION,
		})
	})

	it('would be refused by Course Builder if the guard let the upgrade through', async () => {
		const { paymentsAdapter } = payments()
		const result = await stripeCheckoutResult({
			params: {
				productId: C5_PRODUCT_ID,
				userId: USER_ID,
				quantity: 1,
				bulk: false,
				cancelUrl: 'https://app.test/c5',
				upgradeFromPurchaseId: CC_PURCHASE,
			},
			config: {
				baseSuccessUrl: 'https://app.test',
				cancelUrl: 'https://app.test/cancel',
				errorRedirectUrl: 'https://app.test/error',
				paymentsAdapter,
			},
			adapter,
			requestOptions: { trustedCountry: 'US' },
		})
		expect(JSON.stringify(result)).toContain(
			'authoritative-price-upgrade-unsupported',
		)
	})
})
