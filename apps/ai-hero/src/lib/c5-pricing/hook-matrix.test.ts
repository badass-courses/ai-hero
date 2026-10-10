import type { PricingFacts } from '@ai-hero/front-desk-support'
import {
	price,
	type BindingQuoteData,
	type BuyerFactsData,
} from '@ai-hero/front-desk-support/pricing'
import { describe, expect, it } from 'vitest'

import type { AuthoritativeDecision } from '@coursebuilder/core/schemas'

import { APP_REASONS, C5_PRODUCT_ID, decodeDecisionRef } from './decision'
import { createC5AuthoritativePrice, type BuyerRead } from './hook'
import {
	SYNTHETIC_LEGEND_PRODUCTS,
	SYNTHETIC_LIST,
	SYNTHETIC_POLICY_PRODUCT,
	SYNTHETIC_POLICY_VERSION,
	SYNTHETIC_WINDOWS,
	syntheticPolicy,
} from './synthetic-policy.test-fixture'

/**
 * The generated matrix: every fact combination, every window edge, the team
 * quantities and the quote variants, priced through the app's hook and
 * `toAuthoritativeDecision`. Each cell is checked against a reference price
 * computed here from the synthetic policy alone, not from the engine.
 *
 * Synthetic policy: list 1000.00; new buyers 20% off early, 0% after;
 * alumni 35%; credits 50/100/150; legend 50% plus 50.00, never with a
 * credit; team bands early 20/25/30/40 and standard 0/10/20/30 at 1/5/10/30
 * seats; PPP the better of the formula and the regional price.
 */

const LIST = SYNTHETIC_LIST
const PRICE_ID = 'price-c5'
const CREDITS = [5_000, 10_000, 15_000]
const LEGEND_REFS = SYNTHETIC_LEGEND_PRODUCTS.map((id) => `product:${id}`)
const TEAM_QUANTITIES = [1, 2, 4, 5, 9, 10, 11, 29, 30, 31, 100, 10_000]
const ms = (iso: string) => Date.parse(iso)
const at = (epoch: number) => new Date(epoch)
const W = {
	opens: ms(SYNTHETIC_WINDOWS.opensAt),
	earlyEnds: ms(SYNTHETIC_WINDOWS.earlyEndsAt),
	checkoutStops: ms(SYNTHETIC_WINDOWS.checkoutStopsAt),
	closes: ms(SYNTHETIC_WINDOWS.closesAt),
}
/** Every window edge, and the instant before it. */
const WINDOW_EDGES: readonly [string, Date][] = [
	['before opening', at(W.opens - 1)],
	['at opening', at(W.opens)],
	['the last early instant', at(W.earlyEnds - 1)],
	['the first standard instant', at(W.earlyEnds)],
	['the last checkout instant', at(W.checkoutStops - 1)],
	['when checkout stops', at(W.checkoutStops)],
	['the last enrollment instant', at(W.closes - 1)],
	['when enrollment closes', at(W.closes)],
]

type Gap = 'gap'
const GAP: Gap = 'gap'
type Alumni = 'none' | 'c3' | 'c4' | 'both' | Gap
type Credit = null | number | Gap
type CreditUse = 'available' | 'spent' | Gap
type Legend = 'no' | 'verified' | Gap
/** The PPP inputs the hook reads: trusted country, its percent, consent, history. */
type Ppp =
	| { kind: 'no-country' }
	| { kind: 'country'; percent: number; accepted: boolean; validPurchase: boolean }
type QuoteVariant =
	| 'none'
	| 'below'
	| 'above'
	| 'unit-below'
	| 'expired'
	| 'other-quantity'

const PPP_VARIANTS: readonly Ppp[] = [
	{ kind: 'no-country' },
	{ kind: 'country', percent: 0, accepted: true, validPurchase: false },
	{ kind: 'country', percent: 60, accepted: false, validPurchase: false },
	{ kind: 'country', percent: 60, accepted: true, validPurchase: false },
	{ kind: 'country', percent: 60, accepted: true, validPurchase: true },
	{ kind: 'country', percent: 10, accepted: true, validPurchase: false },
]
const QUOTES: readonly QuoteVariant[] = [
	'none',
	'below',
	'above',
	'unit-below',
	'expired',
	'other-quantity',
]

const known = <A>(value: A, sourceRefs: readonly string[] = ['matrix']) => ({
	value,
	sourceRefs,
})
const fact = <A>(value: A | Gap, refs?: readonly string[]) =>
	value === GAP ? ({ gap: 'FactsUnavailable' } as const) : known(value, refs)

/** A quote for `quantity` seats whose total is `fraction` of the list total. */
function quoteFor(
	variant: QuoteVariant,
	quantity: number,
	now: Date,
): BindingQuoteData[] {
	if (variant === 'none') return []
	const total = LIST * quantity
	const base = {
		currency: 'USD',
		expiresAt: null as string | null,
		product: SYNTHETIC_POLICY_PRODUCT,
		quantity,
		ref: `quote-matrix@1#${variant}`,
	}
	switch (variant) {
		case 'below':
			return [{ ...base, basis: 'Total', amount: Math.round(total * 0.55) }]
		case 'above':
			return [{ ...base, basis: 'Total', amount: Math.round(total * 0.99) }]
		case 'unit-below':
			return [{ ...base, basis: 'Unit', amount: Math.round(LIST * 0.55) }]
		case 'expired':
			return [
				{
					...base,
					basis: 'Total',
					amount: Math.round(total * 0.55),
					expiresAt: new Date(now.getTime() - 1).toISOString(),
				},
			]
		case 'other-quantity':
			return [
				{
					...base,
					basis: 'Total',
					amount: Math.round(total * 0.55),
					quantity: quantity === 1 ? 2 : quantity - 1,
				},
			]
	}
}

/** What a valid quote charges for the order, or null when none applies. */
function quotedAmount(variant: QuoteVariant, quantity: number): number | null {
	const total = LIST * quantity
	if (variant === 'below') return Math.round(total * 0.55)
	if (variant === 'above') return Math.round(total * 0.99)
	if (variant === 'unit-below') return Math.round(LIST * 0.55) * quantity
	return null
}

type Expected =
	| { kind: 'not-open' | 'closed' | 'held' }
	| { kind: 'bounded' }
	| {
			kind: 'priced'
			amount: number
			unit: number
			restriction: 'none' | 'region'
			pppOffer: number | null
			creditSource: string | null
	  }

const windowKind = (now: Date): Expected | null =>
	now.getTime() < W.opens
		? { kind: 'not-open' }
		: now.getTime() >= W.checkoutStops
			? { kind: 'closed' }
			: null
const early = (now: Date) => now.getTime() < W.earlyEnds

/**
 * The reference price for one individual cell. Each rule is a candidate. A
 * candidate whose facts are all known is certain; one that depends on an
 * unknown fact is only a bound at its most favourable. The order is priced
 * when a certain candidate beats every bound, and bounded otherwise.
 */
function expectIndividual(cell: {
	alumni: Alumni
	credit: Credit
	creditUse: CreditUse
	legend: Legend
	ppp: Ppp
	quote: QuoteVariant
	now: Date
}): Expected {
	const closed = windowKind(cell.now)
	if (closed) return closed
	if (typeof cell.credit === 'number' && !CREDITS.includes(cell.credit))
		return { kind: 'held' }
	if (cell.ppp.kind === 'no-country') return { kind: 'bounded' }

	type Candidate = {
		amount: number
		certain: boolean
		creditSource: string | null
		region?: boolean
	}
	// A spent credit is worth nothing, whatever it was.
	const creditKnown =
		cell.creditUse === 'spent' ||
		(cell.credit !== GAP && (cell.credit === null || cell.creditUse !== GAP))
	const credit = !creditKnown
		? cell.credit === GAP
			? Math.max(...CREDITS)
			: (cell.credit as number)
		: typeof cell.credit === 'number' && cell.creditUse === 'available'
			? cell.credit
			: 0
	const creditSource = creditKnown && credit ? 'cc' : null
	const candidates: Candidate[] = [
		{
			amount: (early(cell.now) ? LIST * 0.8 : LIST) - credit,
			certain: creditKnown,
			creditSource,
		},
	]
	if (cell.alumni !== 'none')
		candidates.push({
			amount: LIST * 0.65 - credit,
			certain: creditKnown && cell.alumni !== GAP,
			creditSource,
		})
	if (cell.legend !== 'no')
		candidates.push({
			amount: LIST * 0.5 - 5_000,
			certain: cell.legend === 'verified',
			creditSource: null,
		})
	const quoted = quotedAmount(cell.quote, 1)
	if (quoted !== null)
		candidates.push({ amount: quoted, certain: true, creditSource: null })

	const pppPercent =
		cell.ppp.kind === 'country' && !cell.ppp.validPurchase
			? cell.ppp.percent
			: 0
	const regional =
		pppPercent > 0 ? Math.round(LIST * (1 - pppPercent / 100)) : null
	const accepted = cell.ppp.accepted
	if (accepted && regional !== null)
		candidates.push({
			amount: regional,
			certain: true,
			creditSource: null,
			region: true,
		})

	// On a tie an unrestricted price beats a regional one, and the buyer
	// keeps their credit.
	const rank = (c: Candidate) => [c.amount, c.region ? 1 : 0, c.creditSource ? 1 : 0]
	const before = (a: Candidate, b: Candidate) => {
		const [x, y] = [rank(a), rank(b)]
		for (let i = 0; i < x.length; i++)
			if (x[i] !== y[i]) return x[i]! < y[i]!
		return false
	}
	const lowest = (list: Candidate[]) =>
		list.reduce<Candidate | null>((a, b) => (!a || before(b, a) ? b : a), null)
	const best = lowest(candidates.filter((c) => c.certain))
	const bound = lowest(candidates.filter((c) => !c.certain))
	// An unknown fact that could at best tie the certain price cannot change it.
	if (!best || (bound && bound.amount < best.amount)) return { kind: 'bounded' }
	if (best.region)
		return {
			kind: 'priced',
			amount: best.amount,
			unit: best.amount,
			restriction: 'region',
			pppOffer: null,
			creditSource: null,
		}
	return {
		kind: 'priced',
		amount: best.amount,
		unit: best.amount,
		restriction: 'none',
		pppOffer:
			!accepted && regional !== null && regional < best.amount ? regional : null,
		creditSource: best.creditSource,
	}
}

const band = (seats: number, isEarly: boolean) => {
	const bands = isEarly
		? [
				[30, 40],
				[10, 30],
				[5, 25],
				[1, 20],
			]
		: [
				[30, 30],
				[10, 20],
				[5, 10],
				[1, 0],
			]
	return bands.find(([min]) => seats >= min!)![1]!
}

/** The reference price for one team cell. */
function expectTeam(cell: {
	quantity: number
	existingSeats: number | Gap
	quote: QuoteVariant
	now: Date
}): Expected {
	const closed = windowKind(cell.now)
	if (closed) return closed
	if (cell.existingSeats === GAP) return { kind: 'held' }
	const unit =
		LIST * (1 - band(cell.quantity + cell.existingSeats, early(cell.now)) / 100)
	const formula = unit * cell.quantity
	const quoted = quotedAmount(cell.quote, cell.quantity)
	if (quoted !== null && quoted < formula)
		return {
			kind: 'priced',
			amount: quoted,
			unit:
				cell.quote === 'unit-below'
					? Math.round(LIST * 0.55)
					: Math.round(quoted / cell.quantity),
			restriction: 'none',
			pppOffer: null,
			creditSource: null,
		}
	return {
		kind: 'priced',
		amount: formula,
		unit,
		restriction: 'none',
		pppOffer: null,
		creditSource: null,
	}
}

const product = {
	appProductId: C5_PRODUCT_ID,
	merchantPriceId: PRICE_ID,
	merchantUnit: LIST,
	sourceRefs: ['matrix:product'],
}

function signedIn(
	facts: Omit<BuyerFactsData, 'ppp'>,
	quantity: number,
	validPurchase: boolean,
): BuyerRead {
	return {
		kind: 'buyer',
		email: 'matrix@example.test',
		hasValidPurchase: validPurchase,
		holdsRestrictedPurchase: false,
		facts: {
			product,
			buyer: { userId: 'user-matrix', sourceRefs: ['matrix:user'] },
			quantity,
			facts: { ...facts, ppp: known(null) } as PricingFacts['facts'],
		},
	}
}

async function decide(input: {
	buyer: BuyerRead
	ppp: Ppp
	quotes: BindingQuoteData[]
	now: Date
	quantity: number
	purpose: 'display' | 'checkout'
}): Promise<AuthoritativeDecision | null> {
	const hook = createC5AuthoritativePrice({
		policy: async () => ({
			ok: true,
			value: { version: SYNTHETIC_POLICY_VERSION, policy: syntheticPolicy() },
		}),
		quotes: async () => ({ ok: true, value: input.quotes }),
		buyer: async () => input.buyer,
		trustedCountry: async () => (input.ppp.kind === 'country' ? 'ZZ' : null),
		pppPercent: () => (input.ppp.kind === 'country' ? input.ppp.percent : 0),
		price,
		engineVersion: 'engine-matrix',
		now: () => input.now,
		disabled: () => false,
	})
	return hook({
		purpose: input.purpose,
		productId: C5_PRODUCT_ID,
		priceId: PRICE_ID,
		quantity: input.quantity,
		userId: 'user-matrix',
		country: 'US',
		pppAccepted: input.ppp.kind === 'country' && input.ppp.accepted,
	})
}

/** What one cell got, in the reference's terms. Null when it matches. */
function mismatch(
	expected: Expected,
	decision: AuthoritativeDecision | null,
	quantity: number,
): string | null {
	if (!decision) return 'null decision'
	if (decision.kind !== expected.kind)
		return `kind ${decision.kind}, expected ${expected.kind}`
	if (decision.closesAt !== W.checkoutStops) return `closesAt ${decision.closesAt}`
	if (decision.policyVersion !== SYNTHETIC_POLICY_VERSION) return 'policyVersion'
	if (expected.kind !== 'priced') {
		return decision.amountCents === 0 || expected.kind === 'bounded'
			? null
			: `refusal carries ${decision.amountCents}`
	}
	const got = {
		amount: decision.amountCents,
		unit: decision.unitAmountCents,
		restriction: decision.restriction,
		pppOffer:
			decision.offers.find((offer) => offer.restriction === 'region')
				?.amountCents ?? null,
		creditSource: decodeDecisionRef(decision.decisionRef)?.creditSource ?? null,
	}
	const want = {
		amount: expected.amount,
		unit: expected.unit,
		restriction: expected.restriction,
		pppOffer: expected.pppOffer,
		creditSource: expected.creditSource,
	}
	if (JSON.stringify(got) !== JSON.stringify(want))
		return `${JSON.stringify(got)} != ${JSON.stringify(want)}`
	if (decision.amountCents <= 0 || decision.amountCents > LIST * quantity)
		return 'amount out of range'
	return null
}

const ALUMNI: readonly Alumni[] = ['none', 'c3', 'c4', 'both', GAP]
const CREDIT: readonly Credit[] = [null, 5_000, 10_000, 15_000, 7_000, GAP]
const CREDIT_USE: readonly CreditUse[] = ['available', 'spent', GAP]
const LEGEND: readonly Legend[] = ['no', 'verified', GAP]

describe('generated hook matrix: individual orders', () => {
	it.each(WINDOW_EDGES)(
		'prices every fact, PPP and quote combination %s',
		async (_, now) => {
			const failures: string[] = []
			let cells = 0
			for (const alumni of ALUMNI)
				for (const credit of CREDIT)
					for (const creditUse of CREDIT_USE)
						for (const legend of LEGEND)
							for (const ppp of PPP_VARIANTS)
								for (const quote of QUOTES) {
									const facts = {
										order: known('individual' as const),
										alumni: fact(alumni),
										credit: fact(
											credit === null || credit === GAP
												? credit
												: { paid: credit, source: 'cc' },
										),
										creditUse: fact(creditUse),
										existingSeats: known(0),
										legend: fact(legend, LEGEND_REFS),
									} as Omit<BuyerFactsData, 'ppp'>
									const decision = await decide({
										buyer: signedIn(
											facts,
											1,
											ppp.kind === 'country' && ppp.validPurchase,
										),
										ppp,
										quotes: quoteFor(quote, 1, now),
										now,
										quantity: 1,
										purpose: 'checkout',
									})
									const cell = { alumni, credit, creditUse, legend, ppp, quote }
									const wrong = mismatch(
										expectIndividual({ ...cell, now }),
										decision,
										1,
									)
									cells++
									if (wrong) failures.push(`${JSON.stringify(cell)}: ${wrong}`)
								}
			expect(cells).toBe(
				ALUMNI.length *
					CREDIT.length *
					CREDIT_USE.length *
					LEGEND.length *
					PPP_VARIANTS.length *
					QUOTES.length,
			)
			expect(failures.slice(0, 5)).toEqual([])
		},
		60_000,
	)

	it.each(WINDOW_EDGES)(
		'shows an anonymous buyer the new-buyer price, never a charge, %s',
		async (_, now) => {
			const decision = await decide({
				buyer: { kind: 'anonymous', product },
				ppp: { kind: 'country', percent: 0, accepted: false, validPurchase: false },
				quotes: [],
				now,
				quantity: 1,
				purpose: 'display',
			})
			const closed = windowKind(now)
			if (closed) {
				expect(decision?.kind).toBe(closed.kind)
				return
			}
			expect(decision).toMatchObject({
				kind: 'bounded',
				amountCents: early(now) ? LIST * 0.8 : LIST,
			})
			expect(decision!.reasons).toContain(APP_REASONS.identityRequired)
		},
	)
})

describe('generated hook matrix: team orders', () => {
	const EXISTING: readonly (number | Gap)[] = [0, 1, 4, 25, GAP]
	it.each(WINDOW_EDGES)(
		'prices every quantity, seat count and quote %s',
		async (_, now) => {
			const failures: string[] = []
			for (const quantity of TEAM_QUANTITIES)
				for (const existingSeats of EXISTING)
					for (const quote of QUOTES)
						for (const purpose of ['display', 'checkout'] as const) {
							const facts = {
								order: known('team' as const),
								alumni: fact<'none'>(GAP),
								credit: fact<null>(GAP),
								creditUse: fact<'available'>(GAP),
								existingSeats: fact(existingSeats),
								legend: fact<'no'>(GAP),
							} as Omit<BuyerFactsData, 'ppp'>
							const decision = await decide({
								buyer: signedIn(facts, quantity, false),
								// A team order is never regional, whatever the country.
								ppp: { kind: 'country', percent: 60, accepted: true, validPurchase: false },
								quotes: quoteFor(quote, quantity, now),
								now,
								quantity,
								purpose,
							})
							const cell = { quantity, existingSeats, quote, purpose }
							const wrong = mismatch(
								expectTeam({ quantity, existingSeats, quote, now }),
								decision,
								quantity,
							)
							if (wrong) failures.push(`${JSON.stringify(cell)}: ${wrong}`)
						}
			expect(failures.slice(0, 5)).toEqual([])
		},
		60_000,
	)
})
