import type { PricingFacts } from '@ai-hero/front-desk-support'
import {
	price,
	type BindingQuoteData,
	type BuyerFactsData,
} from '@ai-hero/front-desk-support/pricing'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { BuyerRead, C5PricingDeps } from '@/lib/c5-pricing/hook'
import { C5_PRODUCT_ID } from '@/lib/c5-pricing/products'
import {
	SYNTHETIC_LEGEND_PRODUCTS,
	SYNTHETIC_LIST,
	SYNTHETIC_POLICY_VERSION,
	SYNTHETIC_WINDOWS,
	syntheticPolicy,
} from '@/lib/c5-pricing/synthetic-policy.test-fixture'

import { C5_OFFER_URL, makeOffersPort, type OfferStore } from './offers'

// The real engine over the synthetic policy: list 1000.00, new buyers 20%
// off until earlyEndsAt, alumni 35%, invented PPP percents below.
const PPP: Record<string, number> = { IN: 60 }
const EARLY = new Date('2030-01-05T00:00:00.000Z')
const STANDARD = new Date('2030-02-10T00:00:00.000Z')
const AFTER_CLOSE = new Date('2030-03-02T00:00:00.000Z')

const learner = { userId: 'user-1', tokenKind: 'learner-token' } as const

const known = <A>(value: A, sourceRefs: readonly string[] = ['test']) => ({
	value,
	sourceRefs,
})

const product = {
	appProductId: C5_PRODUCT_ID,
	merchantPriceId: 'price-c5',
	merchantUnit: SYNTHETIC_LIST,
	sourceRefs: ['test:product'],
}

function signedIn(over: Partial<Omit<BuyerFactsData, 'ppp'>> = {}): BuyerRead {
	return {
		kind: 'buyer',
		email: 'buyer@example.test',
		holdsRestrictedPurchase: false,
		holdsValidProductPurchase: false,
		facts: {
			product,
			buyer: { userId: learner.userId, sourceRefs: ['test:user'] },
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
		},
	}
}

let buyer: BuyerRead
let now: Date
let store: OfferStore
let deps: C5PricingDeps

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
		buyer: vi.fn(async (input) =>
			input.userId ? buyer : { kind: 'anonymous' as const, product },
		),
		// The port supplies the country; this must never be read.
		trustedCountry: vi.fn(async () => 'ZZ'),
		pppPercent: (country) => PPP[country] ?? 0,
		price: vi.fn(price),
		engineVersion: 'engine-test',
		now: () => now,
		disabled: () => false,
		...over,
	}
}

const offerFor = (
	caller: typeof learner | null,
	{ country = 'US' }: { country?: string } = {},
) =>
	makeOffersPort({ country, store, pricing: async () => deps }).nextOffer(caller)

beforeEach(() => {
	buyer = signedIn()
	now = EARLY
	deps = makeDeps()
	store = {
		holds: vi.fn(async () => false),
		boughtSeats: vi.fn(async () => false),
		product: vi.fn(async () => ({
			title: 'Cohort Five',
			courseSlug: 'cohort-five',
		})),
	}
})

describe('next offer', () => {
	it('gives an owner no price and runs no pricing', async () => {
		store = { ...store, holds: vi.fn(async () => true) }
		await expect(offerFor(learner)).resolves.toEqual({
			state: 'owns',
			product: {
				id: C5_PRODUCT_ID,
				title: 'Cohort Five',
				url: C5_OFFER_URL,
				courseSlug: 'cohort-five',
			},
			price: null,
			team: null,
		})
		expect(deps.price).not.toHaveBeenCalled()
	})

	it('prices an alum at the alumni price the engine picks', async () => {
		buyer = signedIn({ alumni: known('c4' as const) })
		const offer = await offerFor(learner)
		expect(offer.state).toBe('alumni')
		expect(offer.price).toMatchObject({
			fullCents: 100_000,
			nowCents: 65_000,
			discount: 'alumni',
			upperBound: false,
			// The alumni price does not change at the early-bird end.
			priceEndsAt: SYNTHETIC_WINDOWS.checkoutStopsAt,
			enrollmentClosesAt: SYNTHETIC_WINDOWS.checkoutStopsAt,
		})
	})

	it('gives a new buyer the early-bird price until the early-bird end', async () => {
		const offer = await offerFor(learner)
		expect(offer.state).toBe('standard')
		expect(offer.price).toEqual({
			currency: 'USD',
			fullCents: 100_000,
			nowCents: 80_000,
			discount: 'early_bird',
			upperBound: false,
			includesCrashCourseCredit: false,
			priceEndsAt: SYNTHETIC_WINDOWS.earlyEndsAt,
			enrollmentClosesAt: SYNTHETIC_WINDOWS.checkoutStopsAt,
			regional: null,
		})
	})

	it('gives a new buyer the full price after the early-bird end', async () => {
		now = STANDARD
		const offer = await offerFor(learner)
		expect(offer.price).toMatchObject({
			nowCents: 100_000,
			discount: 'none',
			priceEndsAt: SYNTHETIC_WINDOWS.checkoutStopsAt,
		})
	})

	it('gives an anonymous caller the default new-buyer price, as an upper bound', async () => {
		const offer = await offerFor(null)
		expect(offer.state).toBe('anonymous')
		expect(offer.price).toMatchObject({
			nowCents: 80_000,
			discount: 'early_bird',
			upperBound: true,
		})
		expect(store.holds).not.toHaveBeenCalled()
	})

	it('is closed after enrollment closes, with no price', async () => {
		now = AFTER_CLOSE
		await expect(offerFor(learner)).resolves.toMatchObject({
			state: 'closed',
			price: null,
			team: null,
		})
	})

	it('rejects when pricing cannot run, so the agent reports Unavailable', async () => {
		deps = makeDeps({
			policy: async () => ({ ok: false, reason: 'front-desk-down' }),
		})
		await expect(offerFor(learner)).rejects.toThrow(/held/)
	})

	it('shows the regional price for the port’s country beside the unrestricted one', async () => {
		const offer = await offerFor(learner, { country: 'in' })
		expect(offer.price).toMatchObject({
			nowCents: 80_000,
			discount: 'early_bird',
			regional: {
				nowCents: 40_000,
				discount: 'regional',
				restriction: 'region',
			},
		})
		expect(deps.trustedCountry).not.toHaveBeenCalled()
	})

	it('says when the price already takes off a Crash Course credit', async () => {
		buyer = signedIn({
			credit: known({ paid: 10_000, source: 'cc-purchase' }),
		})
		const offer = await offerFor(learner)
		expect(offer.price).toMatchObject({
			nowCents: 70_000,
			discount: 'early_bird',
			includesCrashCourseCredit: true,
		})
	})

	it('adds the current seat bands for a learner who has bought seats', async () => {
		store = { ...store, boughtSeats: vi.fn(async () => true) }
		const offer = await offerFor(learner)
		expect(offer.team).toEqual({
			seatBands: [
				{ minSeats: 1, percentOff: 20 },
				{ minSeats: 5, percentOff: 25 },
				{ minSeats: 10, percentOff: 30 },
				{ minSeats: 30, percentOff: 40 },
			],
			bandsEndAt: SYNTHETIC_WINDOWS.earlyEndsAt,
		})
	})
})
