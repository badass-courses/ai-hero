import type { PricingFacts } from '@ai-hero/front-desk-support'
import type { PricingResultData } from '@ai-hero/front-desk-support/pricing'
import { beforeEach, describe, expect, it } from 'vitest'

import type { AuthoritativePriceRequest } from '@coursebuilder/core/schemas'

import { APP_REASONS, C5_PRODUCT_ID, decodeDecisionRef } from './decision'
import {
	createC5AuthoritativePrice,
	type BuyerRead,
	type C5PricingDeps,
} from './hook'
import { isPppCreditBound, pppCreditBoundCharge } from './ppp-credit-bound'
import { PPP_CREDIT_BOUNDED_RESULT as vector } from './ppp-credit-bound.test-fixture'
import { purchaseGate } from './purchasability'
import {
	SYNTHETIC_LIST,
	SYNTHETIC_POLICY_VERSION,
	syntheticPolicy,
} from './synthetic-policy.test-fixture'

const PRICE_ID = 'price-c5'
const EARLY = new Date('2030-01-05T00:00:00.000Z')
const known = <A>(value: A) => ({ value, sourceRefs: ['test'] })
const product = {
	appProductId: C5_PRODUCT_ID,
	merchantPriceId: PRICE_ID,
	merchantUnit: SYNTHETIC_LIST,
	sourceRefs: ['test:product'],
}
const signedIn: BuyerRead = {
	kind: 'buyer',
	email: 'buyer@example.test',
	facts: {
		product,
		buyer: { userId: 'user-1', sourceRefs: ['test:user'] },
		quantity: 1,
		facts: {
			order: known('individual' as const),
			alumni: known('none' as const),
			credit: { gap: 'PaymentAmbiguous' },
			creditUse: known('available' as const),
			existingSeats: known(0),
			legend: known('no' as const),
			ppp: known(null),
		} as PricingFacts['facts'],
	},
	holdsRestrictedPurchase: false,
	holdsValidProductPurchase: false,
}

/** The vector after the buyer's credit resolved: credit off the regional price. */
const credited: PricingResultData = {
	...vector,
	kind: 'priced',
	amount: 22_475,
	unitAmount: 22_475,
	creditSource: 'purchase-cc',
	reasons: [
		{ code: 'early-window', detail: '' },
		{ code: 'selected', detail: 'ppp' },
	],
}

const unresolvedCreditUse = {
	candidate: 'credit',
	fact: 'creditUse',
	gap: 'FactsUnavailable',
	needs: 'creditUse',
} as const
const mutations: [string, PricingResultData][] = [
	[
		'a second unresolved creditUse',
		{
			...vector,
			unresolved: [...vector.unresolved, unresolvedCreditUse],
		},
	],
	[
		'a second unresolved ppp',
		{
			...vector,
			unresolved: [
				...vector.unresolved,
				{ ...unresolvedCreditUse, candidate: 'ppp', fact: 'ppp' },
			],
		},
	],
	[
		'an unresolved legend instead',
		{
			...vector,
			unresolved: [
				{ ...vector.unresolved[0], candidate: 'legend', fact: 'legend' },
			],
		},
	],
	['kind held', { kind: 'held', reasons: vector.reasons }],
	[
		'engine 0.1, which keeps the credit off the regional price',
		{ ...vector, engineVersion: '0.1.0' },
	],
	['an unreadable engine version', { ...vector, engineVersion: 'next' }],
	['rule new', { ...vector, rule: 'new' }],
	['basis formula', { ...vector, basis: 'formula' }],
	['no region restriction', { ...vector, restriction: 'none' }],
	['a credit source', { ...vector, creditSource: 'purchase-cc' }],
	[
		'a second fact-unknown',
		{
			...vector,
			reasons: [
				...vector.reasons,
				{ code: 'fact-unknown', detail: 'creditUse: FactsUnavailable' },
			],
		},
	],
	[
		'a fact-unknown for another fact',
		{
			...vector,
			reasons: [
				{ code: 'early-window', detail: '' },
				{ code: 'fact-unknown', detail: 'legend: FactsUnavailable' },
				{ code: 'selected', detail: 'ppp' },
			],
		},
	],
	[
		'a credit-spent reason',
		{
			...vector,
			reasons: [...vector.reasons, { code: 'credit-spent', detail: '' }],
		},
	],
	[
		'a held-class reason',
		{
			...vector,
			reasons: [...vector.reasons, { code: 'checkout-stopped', detail: '' }],
		},
	],
]

let buyer: BuyerRead
/** The engine's result for each purpose: checkout runs the engine again. */
let results: Record<'display' | 'checkout', PricingResultData>
const ask = async (
	at: 'display' | 'checkout',
	over: Partial<AuthoritativePriceRequest> = {},
	deps: Partial<C5PricingDeps> = {},
) => {
	const decide = createC5AuthoritativePrice({
		policy: async () => ({
			ok: true,
			value: { version: SYNTHETIC_POLICY_VERSION, policy: syntheticPolicy() },
		}),
		quotes: async () => ({ ok: true, value: [] }),
		buyer: async () => buyer,
		trustedCountry: async () => 'IN',
		pppPercent: () => 75,
		price: () => ({ ok: true, value: results[at] }),
		engineVersion: 'engine-test',
		now: () => EARLY,
		disabled: () => false,
		...deps,
	})
	const request = {
		purpose: at,
		productId: C5_PRODUCT_ID,
		priceId: PRICE_ID,
		quantity: 1,
		userId: 'user-1',
		country: 'IN',
		pppAccepted: true,
		...over,
	}
	const decision = await decide(request)
	return { request, decision }
}
const gateOf = (decision: Awaited<ReturnType<typeof ask>>['decision']) =>
	purchaseGate({
		authoritative: {
			...decision!,
			purchasable: decision!.kind === 'priced',
			isUpperBound: decision!.kind === 'bounded',
		},
	})

beforeEach(() => {
	buyer = signedIn
	results = { display: vector, checkout: vector }
})

describe('isPppCreditBound', () => {
	it("matches front-desk's engine 0.2.0 vector", () => {
		expect(isPppCreditBound(vector)).toBe(true)
	})

	it.each(mutations)('does not match %s', (_, result) => {
		expect(isPppCreditBound(result)).toBe(false)
	})

	it('does not match a priced result', () => {
		expect(isPppCreditBound(credited)).toBe(false)
	})
})

describe('a regional price bounded only by the credit', () => {
	it('can buy, and checkout charges the bound with no credit source', async () => {
		const display = await ask('display')
		expect(display.decision).toMatchObject({
			kind: 'bounded',
			amountCents: 32_375,
		})
		expect(display.decision!.reasons).toContain(APP_REASONS.pppCreditBound)
		expect(gateOf(display.decision)).toEqual({ kind: 'buy', upperBound: false })
		expect(pppCreditBoundCharge(display.request, display.decision)).toBeNull()

		const checkout = await ask('checkout')
		expect(checkout.decision).toMatchObject({
			kind: 'priced',
			amountCents: 32_375,
			restriction: 'region',
		})
		expect(decodeDecisionRef(checkout.decision!.decisionRef)).toMatchObject({
			creditSource: null,
		})
		expect(pppCreditBoundCharge(checkout.request, checkout.decision)).toEqual({
			productId: C5_PRODUCT_ID,
			userId: 'user-1',
			amountCents: 32_375,
			restriction: 'region',
			decisionRef: checkout.decision!.decisionRef,
			policyVersion: vector.policyVersion,
			engineVersion: vector.engineVersion,
		})
	})

	it('charges the credited price when the credit resolved before checkout', async () => {
		results = { display: vector, checkout: credited }
		const display = await ask('display')
		expect(gateOf(display.decision)).toEqual({ kind: 'buy', upperBound: false })

		const checkout = await ask('checkout')
		expect(checkout.decision).toMatchObject({
			kind: 'priced',
			amountCents: 22_475,
		})
		expect(checkout.decision!.reasons).not.toContain(APP_REASONS.pppCreditBound)
		expect(
			decodeDecisionRef(checkout.decision!.decisionRef)?.creditSource,
		).toBe('purchase-cc')
		expect(pppCreditBoundCharge(checkout.request, checkout.decision)).toBeNull()
	})

	it.each(mutations)('stays blocked with %s', async (_, result) => {
		results = { display: result, checkout: result }
		for (const at of ['display', 'checkout'] as const) {
			const { request, decision } = await ask(at)
			expect(decision!.kind).not.toBe('priced')
			expect(decision!.reasons).not.toContain(APP_REASONS.pppCreditBound)
			expect(gateOf(decision).kind).toBe('blocked')
			expect(pppCreditBoundCharge(request, decision)).toBeNull()
		}
	})

	it('keeps an anonymous buyer on sign-in and never charges the bound', async () => {
		buyer = { kind: 'anonymous', product }
		for (const at of ['display', 'checkout'] as const) {
			const { request, decision } = await ask(at, { userId: undefined })
			expect(decision).toMatchObject({ kind: 'bounded' })
			expect(decision!.reasons).toContain(APP_REASONS.identityRequired)
			expect(decision!.reasons).not.toContain(APP_REASONS.pppCreditBound)
			expect(gateOf(decision)).toEqual({ kind: 'sign-in', upperBound: true })
			expect(pppCreditBoundCharge(request, decision)).toBeNull()
		}
	})

	it('keeps a display without fresh quotes blocked', async () => {
		const { decision } = await ask(
			'display',
			{},
			{ quotes: async () => ({ ok: false, reason: 'down' }) },
		)
		expect(decision!.reasons).toContain(APP_REASONS.quotesUnavailable)
		expect(decision!.reasons).not.toContain(APP_REASONS.pppCreditBound)
		expect(gateOf(decision).kind).toBe('blocked')
	})
})
