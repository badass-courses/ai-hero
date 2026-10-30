import { policyOpeningWindow } from '@/lib/c5-pricing/buyer-opening'
import { noGift } from '@/lib/c5-pricing/gift-slots'
import {
	createC5AuthoritativePrice,
	type BuyerRead,
	type C5PricingDeps,
} from '@/lib/c5-pricing/hook'
import { C5_PRODUCT_ID } from '@/lib/c5-pricing/products'
import { APP_REASONS } from '@/lib/c5-pricing/reasons'
import { normalizeCountry } from '@/lib/c5-pricing/trusted-country'
import type {
	PricingPolicyData,
	PricingResultData,
} from '@ai-hero/front-desk-support/pricing'

import type {
	Learner,
	NextOffer,
	OfferPrice,
	OfferTeam,
	OffersPort,
} from '@ai-hero/learner-agent'

/** The desk's tracked shortlink to the C5 sales page, for agent traffic. */
export const C5_OFFER_URL = 'https://www.aihero.dev/s/c5-mcp'

/** The app's reads behind the offer, apart from pricing. */
export type OfferStore = {
	/** A purchase of the product in a status that grants access. */
	readonly holds: (userId: string, productId: string) => Promise<boolean>
	/** Whether the user has bought team seats of any product. */
	readonly boughtSeats: (userId: string) => Promise<boolean>
	readonly product: (productId: string) => Promise<{
		readonly title: string
		readonly courseSlug: string | null
	} | null>
}

type Priced = Extract<PricingResultData, { kind: 'priced' | 'bounded' }>
type Window = Awaited<ReturnType<NonNullable<C5PricingDeps['openingWindow']>>>

const iso = (at: number | string) => new Date(at).toISOString()
const ruled = <A>(ruling: { value: A } | { question: string }) =>
	'value' in ruling ? ruling.value : null

/**
 * The engine's winning rule, as the learner reads it. `legend` is the deeper
 * returning-student price; every legend holder owns all four earlier cohorts.
 * Team and gift-code rules never win a one-seat price with no gift, so they
 * are not here: an unknown rule fails rather than being labelled.
 */
function discountFor(
	result: Priced,
	early: boolean,
): OfferPrice['discount'] {
	switch (result.rule) {
		case 'new':
			return early ? 'early_bird' : 'none'
		case 'alumni':
		case 'legend':
			return 'alumni'
		case 'ppp':
			return 'regional'
		case 'quote':
			return 'quote'
		default:
			throw new Error(`next_offer: unmapped pricing rule ${result.rule}`)
	}
}

const isAlumnus = (buyer: BuyerRead | undefined) => {
	if (buyer?.kind !== 'buyer') return false
	const alumni = buyer.facts.facts.alumni
	return 'value' in alumni && alumni.value !== 'none'
}

/**
 * One seat of C5 for this caller, priced by checkout's own hook over
 * checkout's own deps. The wrappers only watch: they record the policy,
 * window, buyer facts and engine result the hook used, so the offer can
 * name which rule won and when it ends without a second source of truth.
 */
async function priceOffer(
	deps: C5PricingDeps,
	{
		learner,
		country,
		teamBuyer,
	}: { learner: Learner | null; country: string; teamBuyer: boolean },
): Promise<Omit<NextOffer, 'product'>> {
	const seen: {
		policy?: PricingPolicyData
		window?: Window
		buyer?: BuyerRead
		result?: PricingResultData
	} = {}
	const decide = createC5AuthoritativePrice({
		...deps,
		// A gift is one buyer's pre-opening exception, carried by a browser
		// cookie. An agent call has none.
		code: async () => noGift(),
		trustedCountry: async () => normalizeCountry(country) ?? 'US',
		policy: async (productId) => {
			const read = await deps.policy(productId)
			if (read.ok) seen.policy = read.value.policy
			return read
		},
		openingWindow: async (policy) =>
			(seen.window = deps.openingWindow
				? await deps.openingWindow(policy)
				: policyOpeningWindow(policy)),
		buyer: async (input) => (seen.buyer = await deps.buyer(input)),
		price: (request) => {
			const priced = deps.price(request)
			if (priced.ok && priced.value) seen.result = priced.value
			return priced
		},
	})

	const decision = await decide({
		purpose: 'display',
		productId: C5_PRODUCT_ID,
		quantity: 1,
		...(learner ? { userId: learner.userId } : {}),
		country,
		pppAccepted: false,
	})
	if (!decision) throw new Error('next_offer: C5 has no pricing decision')

	switch (decision.kind) {
		case 'closed':
			return { state: 'closed', price: null, team: null }
		case 'not-open':
			return { state: 'not_yet_open', price: null, team: null }
		case 'held':
			// A regional ticket is held only because it is already owned.
			if (decision.reasons.includes(APP_REASONS.restrictedHolder))
				return { state: 'owns', price: null, team: null }
			throw new Error(`next_offer: price held (${decision.reasons.join(', ')})`)
	}

	const { policy, result, window } = seen
	if (
		!policy ||
		!result ||
		(result.kind !== 'priced' && result.kind !== 'bounded')
	)
		throw new Error('next_offer: priced without an engine result')

	const early = result.reasons.some((reason) => reason.code === 'early-window')
	const earlyEndsAt = ruled(policy.earlyEndsAt)
	const closes = [
		window?.checkoutStopsAt,
		window?.closesAt,
		...(window ? [] : [ruled(policy.checkoutStopsAt), ruled(policy.closesAt)]),
	]
		.map((at) => (typeof at === 'string' ? Date.parse(at) : at))
		.filter((at): at is number => typeof at === 'number' && Number.isFinite(at))
	const enrollmentClosesAt = closes.length ? iso(Math.min(...closes)) : null
	const phaseEndsAt = early && earlyEndsAt ? iso(earlyEndsAt) : null

	const regional = decision.offers.find(
		(offer) => offer.restriction === 'region',
	)
	const bands = ruled(policy.teamBands)

	return {
		state: !learner
			? 'anonymous'
			: isAlumnus(seen.buyer)
				? 'alumni'
				: 'standard',
		price: {
			currency: 'USD',
			fullCents: policy.list,
			nowCents: decision.amountCents,
			discount: discountFor(result, early),
			upperBound: decision.kind === 'bounded',
			includesCrashCourseCredit: result.creditSource !== null,
			priceEndsAt:
				result.rule === 'quote'
					? null
					: result.rule === 'new'
						? (phaseEndsAt ?? enrollmentClosesAt)
						: enrollmentClosesAt,
			enrollmentClosesAt,
			regional: regional
				? {
						nowCents: regional.amountCents,
						discount: 'regional',
						restriction: 'region',
					}
				: null,
		},
		team:
			teamBuyer && bands
				? ({
						seatBands: bands[early ? 'early' : 'standard'].map((band) => ({
							minSeats: band.minSeats,
							percentOff: band.percent,
						})),
						bandsEndAt: phaseEndsAt,
					} satisfies OfferTeam)
				: null,
	}
}

export function makeOffersPort({
	country,
	store,
	pricing = async () =>
		(await import('@/lib/c5-pricing/server')).c5PricingDeps,
}: {
	country: string
	store: OfferStore
	pricing?: () => Promise<C5PricingDeps>
}): OffersPort {
	const holds = (learner: Learner) => store.holds(learner.userId, C5_PRODUCT_ID)

	return {
		ownsOffer: holds,
		nextOffer: async (learner) => {
			const [product, owns, teamBuyer] = await Promise.all([
				store.product(C5_PRODUCT_ID),
				learner ? holds(learner) : false,
				learner ? store.boughtSeats(learner.userId) : false,
			])
			if (!product)
				throw new Error(`next_offer: product ${C5_PRODUCT_ID} not found`)
			const offered: NextOffer['product'] = {
				id: C5_PRODUCT_ID,
				title: product.title,
				url: C5_OFFER_URL,
				courseSlug: product.courseSlug,
			}
			if (owns)
				return { state: 'owns', product: offered, price: null, team: null }
			return {
				product: offered,
				...(await priceOffer(await pricing(), { learner, country, teamBuyer })),
			}
		},
	}
}
