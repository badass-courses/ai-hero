import type { PricingFacts } from '@ai-hero/front-desk-support'
import {
	price,
	type BindingQuoteData,
	type BuyerFactsData,
} from '@ai-hero/front-desk-support/pricing'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { AuthoritativePriceRequest } from '@coursebuilder/core/schemas'

import { APP_REASONS, C5_PRODUCT_ID, decodeDecisionRef } from './decision'
import { createC5AuthoritativePrice, type BuyerRead, type C5PricingDeps } from './hook'
import {
	SYNTHETIC_LEGEND_PRODUCTS,
	SYNTHETIC_LIST,
	SYNTHETIC_POLICY_PRODUCT,
	SYNTHETIC_POLICY_VERSION,
	SYNTHETIC_WINDOWS,
	syntheticPolicy,
} from './synthetic-policy.test-fixture'

// Synthetic policy throughout: list 1000.00, new buyers 20% off early,
// alumni 35%, credits 50/100/150. Invented PPP percents below.
const PPP: Record<string, number> = { IN: 60, BR: 40 }
const EARLY = new Date('2030-01-05T00:00:00.000Z')
const PRICE_ID = 'price-c5'

const known = <A>(value: A, sourceRefs: readonly string[] = ['test']) => ({
	value,
	sourceRefs,
})

const product = {
	appProductId: C5_PRODUCT_ID,
	merchantPriceId: PRICE_ID,
	merchantUnit: SYNTHETIC_LIST,
	sourceRefs: ['test:product'],
}

function buyerFacts(
	over: Partial<Omit<BuyerFactsData, 'ppp'>> = {},
): PricingFacts {
	return {
		product,
		buyer: { userId: 'user-1', sourceRefs: ['test:user'] },
		quantity: 1,
		facts: {
			order: known('individual' as const),
			alumni: known('none' as const),
			credit: known(null),
			creditUse: known('available' as const),
			existingSeats: known(0),
			legend: known(
				'no' as const,
				SYNTHETIC_LEGEND_PRODUCTS.map((id) => `product:${id}`),
			),
			ppp: known(null),
			...over,
		} as PricingFacts['facts'],
	}
}

const signedIn = (
	facts = buyerFacts(),
	hasValidPurchase: boolean | null = false,
): BuyerRead => ({
	kind: 'buyer',
	email: 'buyer@example.test',
	facts,
	hasValidPurchase,
	holdsRestrictedPurchase: false,
})

let deps: C5PricingDeps
let buyer: BuyerRead
let country: string | null

function makeDeps(over: Partial<C5PricingDeps> = {}): C5PricingDeps {
	return {
		policy: vi.fn(async () => ({
			ok: true as const,
			value: { version: SYNTHETIC_POLICY_VERSION, policy: syntheticPolicy() },
		})),
		quotes: vi.fn(async () => ({
			ok: true as const,
			value: [] as readonly BindingQuoteData[],
		})),
		buyer: vi.fn(async () => buyer),
		trustedCountry: vi.fn(async () => country),
		pppPercent: (c) => PPP[c] ?? 0,
		price,
		engineVersion: 'engine-test',
		now: () => EARLY,
		disabled: () => false,
		...over,
	}
}

const ask = (over: Partial<AuthoritativePriceRequest> = {}) =>
	createC5AuthoritativePrice(deps)({
		purpose: 'display',
		productId: C5_PRODUCT_ID,
		priceId: PRICE_ID,
		quantity: 1,
		userId: 'user-1',
		country: 'US',
		pppAccepted: false,
		...over,
	})

beforeEach(() => {
	buyer = signedIn()
	country = 'US'
	deps = makeDeps()
})

describe('createC5AuthoritativePrice', () => {
	it('returns an explicit null, never undefined, for every other product', async () => {
		const result = await ask({ productId: 'product-ma254' })
		expect(result).toBeNull()
		expect(result).not.toBeUndefined()
		expect(deps.policy).not.toHaveBeenCalled()
	})

	it('prices a signed-in new buyer in the early window', async () => {
		const decision = await ask({ purpose: 'checkout' })
		expect(decision).toMatchObject({
			kind: 'priced',
			amountCents: 80_000,
			unitAmountCents: 80_000,
			restriction: 'none',
			offers: [],
			policyVersion: SYNTHETIC_POLICY_VERSION,
			closesAt: Date.parse(SYNTHETIC_WINDOWS.checkoutStopsAt),
		})
		expect(decodeDecisionRef(decision!.decisionRef)).toMatchObject({
			creditSource: null,
		})
	})

	it('prices alumni from the app facts', async () => {
		buyer = signedIn(buyerFacts({ alumni: known('c4' as const) }))
		await expect(ask()).resolves.toMatchObject({
			kind: 'priced',
			amountCents: 65_000,
		})
	})

	it('carries the spent credit purchase in the decision ref', async () => {
		buyer = signedIn(
			buyerFacts({
				credit: known({ paid: 10_000, source: 'purchase-cc' }),
			}),
		)
		const decision = await ask({ purpose: 'checkout' })
		expect(decision).toMatchObject({ kind: 'priced', amountCents: 70_000 })
		expect(decodeDecisionRef(decision!.decisionRef)?.creditSource).toBe(
			'purchase-cc',
		)
	})

	it('shows anonymous display the new-buyer price as a provisional upper bound', async () => {
		buyer = { kind: 'anonymous', product }
		const decision = await ask({ userId: undefined })
		expect(decision).toMatchObject({ kind: 'bounded', amountCents: 80_000 })
		expect(decision!.reasons).toContain(APP_REASONS.identityRequired)
		expect(deps.quotes).not.toHaveBeenCalled()
	})

	it('closes C5 on the kill switch instead of falling back to list pricing', async () => {
		deps = makeDeps({ disabled: () => true })
		const decision = await ask()
		expect(decision).toMatchObject({ kind: 'closed' })
		expect(decision!.reasons).toEqual([APP_REASONS.killSwitch])
		expect(deps.policy).not.toHaveBeenCalled()
	})

	it.each([
		[
			'no policy',
			() => makeDeps({ policy: async () => ({ ok: false, reason: 'x' }) }),
			APP_REASONS.policyUnavailable,
		],
		[
			'unreadable buyer facts',
			() =>
				makeDeps({ buyer: async () => ({ kind: 'unavailable', reason: 'db' }) }),
			APP_REASONS.factsUnavailable,
		],
	])('holds with %s', async (_, make, reason) => {
		deps = make()
		await expect(ask({ purpose: 'checkout' })).resolves.toMatchObject({
			kind: 'held',
			amountCents: 0,
			reasons: [reason],
		})
	})

	it('sends a regional ticket holder to support on display and at checkout', async () => {
		buyer = { ...signedIn(), holdsRestrictedPurchase: true } as BuyerRead
		for (const purpose of ['display', 'checkout'] as const)
			expect(await ask({ purpose })).toMatchObject({
				kind: 'held',
				reasons: [APP_REASONS.restrictedHolder],
			})
		// Buying seats for a team is not an upgrade.
		buyer = {
			...signedIn(buyerFacts({ order: known('team' as const) })),
			holdsRestrictedPurchase: true,
		} as BuyerRead
		expect(await ask({ quantity: 5, purpose: 'checkout' })).toMatchObject({
			kind: 'priced',
		})
	})

	it('holds when Course Builder would charge a different price row', async () => {
		await expect(ask({ priceId: 'price-other' })).resolves.toMatchObject({
			kind: 'held',
			reasons: [APP_REASONS.priceMismatch],
		})
	})

	it('reads quotes fresh at checkout and holds rather than charge the formula without them', async () => {
		deps = makeDeps({ quotes: vi.fn(async () => ({ ok: false as const, reason: 'down' })) })
		await expect(ask({ purpose: 'checkout' })).resolves.toMatchObject({
			kind: 'held',
			reasons: [APP_REASONS.quotesUnavailableAtCheckout],
		})
		expect(deps.quotes).toHaveBeenCalledWith(
			expect.objectContaining({ fresh: true }),
		)
	})

	it('marks display provisional when quotes are unreadable', async () => {
		deps = makeDeps({ quotes: vi.fn(async () => ({ ok: false as const, reason: 'down' })) })
		const decision = await ask()
		expect(decision).toMatchObject({ kind: 'bounded', amountCents: 80_000 })
		expect(decision!.reasons).toContain(APP_REASONS.quotesUnavailable)
		expect(deps.quotes).toHaveBeenCalledWith(
			expect.objectContaining({ fresh: false }),
		)
	})

	it('charges a binding quote below the formula', async () => {
		deps = makeDeps({
			quotes: async () => ({
				ok: true,
				value: [
					{
						amount: 50_000,
						basis: 'Unit',
						currency: 'USD',
						expiresAt: null,
						product: SYNTHETIC_POLICY_PRODUCT,
						quantity: 1,
						ref: 'quote-synthetic@1#line-1',
					},
				],
			}),
		})
		await expect(ask({ purpose: 'checkout' })).resolves.toMatchObject({
			kind: 'priced',
			amountCents: 50_000,
		})
	})

	it('reports not-open and closed windows with no purchasable price', async () => {
		deps = makeDeps({ now: () => new Date('2029-12-01T00:00:00.000Z') })
		await expect(ask()).resolves.toMatchObject({ kind: 'not-open' })
		deps = makeDeps({ now: () => new Date('2030-04-01T00:00:00.000Z') })
		await expect(ask()).resolves.toMatchObject({ kind: 'closed' })
	})

	describe('PPP from the trusted country only', () => {
		it('ignores a spoofed request country', async () => {
			country = 'US'
			const decision = await ask({ country: 'IN', pppAccepted: true })
			expect(decision).toMatchObject({
				kind: 'priced',
				amountCents: 80_000,
				restriction: 'none',
				offers: [],
			})
		})

		it('offers the regional price for the trusted country until the buyer accepts it', async () => {
			country = 'IN'
			const offered = await ask({ country: 'US' })
			expect(offered).toMatchObject({
				kind: 'priced',
				amountCents: 80_000,
				restriction: 'none',
				offers: [{ amountCents: 40_000, percent: 0.6, restriction: 'region' }],
			})
			const accepted = await ask({ country: 'US', pppAccepted: true })
			expect(accepted).toMatchObject({
				kind: 'priced',
				amountCents: 40_000,
				restriction: 'region',
			})
		})

		it('keeps the legacy rule: a Valid purchase blocks PPP', async () => {
			country = 'IN'
			buyer = signedIn(buyerFacts(), true)
			await expect(ask({ pppAccepted: true })).resolves.toMatchObject({
				amountCents: 80_000,
				restriction: 'none',
				offers: [],
			})
		})

		it('never prices PPP for a team order', async () => {
			country = 'IN'
			buyer = signedIn({
				...buyerFacts({
					order: known('team' as const),
					existingSeats: known(0),
				}),
				quantity: 5,
			})
			const decision = await ask({ quantity: 5, pppAccepted: true })
			expect(decision).toMatchObject({ kind: 'priced', restriction: 'none' })
			expect(decision!.offers).toEqual([])
		})
	})
})
