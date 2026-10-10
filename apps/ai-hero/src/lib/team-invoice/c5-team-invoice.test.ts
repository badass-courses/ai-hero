import type { PricingFacts } from '@ai-hero/front-desk-support'
import { price } from '@ai-hero/front-desk-support/pricing'
import { C5_PRODUCT_ID } from '@/lib/c5-pricing/decision'
import { createC5AuthoritativePrice, type BuyerRead } from '@/lib/c5-pricing/hook'
import {
	SYNTHETIC_LEGEND_PRODUCTS,
	SYNTHETIC_LIST,
	SYNTHETIC_POLICY_VERSION,
	syntheticPolicy,
} from '@/lib/c5-pricing/synthetic-policy.test-fixture'
import { describe, expect, it } from 'vitest'

import {
	formatAuthoritativePrice,
	requestAuthoritativeDecision,
} from '@coursebuilder/commerce/authoritative-price'
import type { Price, Product } from '@coursebuilder/core/schemas'

import {
	appBulkPriceSource,
	cappedAtCheckout,
	enginePriceSource,
	teamPriceSourceFor,
	type TeamPriceRequest,
} from './team-price-source'

// The real hook, Course Builder's own formatting and the real engine, on the
// synthetic policy. A company with no account buys ten seats by invoice.
const EARLY = new Date('2030-01-05T00:00:00.000Z')
const PRICE_ID = 'price-c5'
const product = {
	appProductId: C5_PRODUCT_ID,
	merchantPriceId: PRICE_ID,
	merchantUnit: SYNTHETIC_LIST,
	sourceRefs: ['test:product'],
}
const known = <A>(value: A) => ({ value, sourceRefs: ['test'] })
const policy = async () => ({
	ok: true as const,
	value: { version: SYNTHETIC_POLICY_VERSION, policy: syntheticPolicy() },
})
const noQuotes = async () => ({ ok: true as const, value: [] })

/** A signed-in buyer with no seats yet, as checkout would read them. */
const signedIn = (quantity: number): BuyerRead => ({
	kind: 'buyer',
	email: 'team@example.test',
	hasValidPurchase: false,
	holdsRestrictedPurchase: false,
	facts: {
		product,
		buyer: { userId: 'user-team', sourceRefs: ['test:user'] },
		quantity,
		facts: {
			order: known('team' as const),
			alumni: known('none' as const),
			credit: known(null),
			creditUse: known('available' as const),
			existingSeats: known(0),
			legend: {
				value: 'no' as const,
				sourceRefs: SYNTHETIC_LEGEND_PRODUCTS.map((id) => `product:${id}`),
			},
			ppp: known(null),
		} as PricingFacts['facts'],
	},
})

const hook = createC5AuthoritativePrice({
	policy,
	quotes: noQuotes,
	buyer: async ({ userId, quantity }) =>
		userId ? signedIn(quantity) : { kind: 'anonymous', product },
	trustedCountry: async () => 'US',
	pppPercent: () => 0,
	price,
	engineVersion: 'engine-test',
	now: () => EARLY,
	disabled: () => false,
})
const adapter = { authoritativePrice: hook }

const decide = (purpose: 'display' | 'checkout', quantity: number, userId?: string) =>
	requestAuthoritativeDecision(adapter, {
		purpose,
		productId: C5_PRODUCT_ID,
		priceId: PRICE_ID,
		quantity,
		...(userId && { userId }),
		country: 'US',
		pppAccepted: false,
	})

/** The cap the invoice used to take: the app's own display price. */
const appBulk = appBulkPriceSource({
	defaultSaleCoupon: async () => null,
	stripeCouponIdFor: async () => null,
	formatPrice: async (request) => {
		const decision = await decide('display', request.quantity, request.userId)
		return formatAuthoritativePrice({
			product: { id: C5_PRODUCT_ID } as Product,
			price: { id: PRICE_ID, unitAmount: SYNTHETIC_LIST / 100 } as Price,
			quantity: request.quantity,
			country: 'US',
			decision: decision!,
		}) as never
	},
})
const engine = enginePriceSource({
	policy,
	quotes: noQuotes,
	price,
	now: () => EARLY,
	disabled: () => false,
})

const noAccount: TeamPriceRequest = {
	productId: C5_PRODUCT_ID,
	quantity: 10,
	existingSeats: 0,
	listUnitAmount: SYNTHETIC_LIST,
	email: 'new-team@example.test',
}

describe('a C5 team invoice for a billing email with no account', () => {
	it('could never be invoiced through the display cap: anonymous display is only an upper bound', async () => {
		expect((await decide('display', 10))?.kind).toBe('bounded')
		await expect(
			cappedAtCheckout(engine, appBulk).price(noAccount),
		).resolves.toEqual({
			kind: 'unavailable',
			reason: 'checkout-cap-app-authoritative-bounded',
		})
	})

	it('is priced by the engine at what checkout charges a signed-in buyer with no seats', async () => {
		const invoice = await teamPriceSourceFor(C5_PRODUCT_ID, {
			appBulk,
			engine,
		}).price(noAccount)
		const checkout = await decide('checkout', 10, 'user-team')
		expect(checkout).toMatchObject({ kind: 'priced' })
		// Synthetic early band: 10+ seats, 30% off.
		expect(invoice).toEqual({
			kind: 'priced',
			source: 'engine',
			unitAmount: 70_000,
			amount: checkout!.amountCents,
			policy: `${SYNTHETIC_POLICY_VERSION}:team`,
			discount: { kind: 'amount-off', amountOff: 300_000 },
		})
	})

	it.each([2, 4, 5, 9, 11, 29, 30, 31])(
		'matches checkout at %i seats',
		async (quantity) => {
			const invoice = await engine.price({ ...noAccount, quantity })
			const checkout = await decide('checkout', quantity, 'user-team')
			expect(invoice).toMatchObject({
				kind: 'priced',
				amount: checkout!.amountCents,
			})
		},
	)
})
