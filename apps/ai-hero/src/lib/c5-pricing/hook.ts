import type {
	BindingQuoteData,
	BuyerFactsData,
	FactData,
	PricingResultData,
	PriceRequestData,
} from '@ai-hero/front-desk-support/pricing'
import type { PricingFacts } from '@ai-hero/front-desk-support'

import type {
	AuthoritativeDecision,
	AuthoritativePriceRequest,
} from '@coursebuilder/core/schemas'

import type { DataRead, PolicyDocument } from './front-desk-data'
import {
	APP_REASONS,
	C5_PRODUCT_ID,
	provisional,
	refusal,
	toAuthoritativeDecision,
} from './decision'

/**
 * What the hook knows about the buyer. A signed-in buyer's facts come from
 * this app's own sources (`buyerPricingFacts`). Nobody signed in is
 * anonymous; facts that cannot be read are unavailable, never empty.
 */
export type BuyerRead =
	| {
			readonly kind: 'buyer'
			readonly email: string
			readonly facts: PricingFacts
			/** Whether any purchase blocks PPP, as legacy PPP does; null: unknown. */
			readonly hasValidPurchase: boolean | null
			/** Whether the buyer holds a region-restricted purchase of this product. */
			readonly holdsRestrictedPurchase: boolean
	  }
	| {
			readonly kind: 'anonymous'
			readonly product: PricingFacts['product']
	  }
	| { readonly kind: 'unavailable'; readonly reason: string }

export type C5PricingDeps = {
	readonly policy: (productId: string) => Promise<DataRead<PolicyDocument>>
	readonly quotes: (input: {
		readonly email: string
		readonly productId: string
		readonly quantity: number
		readonly fresh: boolean
	}) => Promise<DataRead<readonly BindingQuoteData[]>>
	readonly buyer: (input: {
		readonly userId: string | null
		readonly productId: string
		readonly quantity: number
		readonly orderKind: 'individual' | 'team'
		readonly purpose: 'display' | 'checkout'
	}) => Promise<BuyerRead>
	/**
	 * The buyer's country from AI Hero's trusted request geolocation, the source
	 * the coupon guard uses. Null outside a request. Never the `country` Course
	 * Builder passes in, which the display path still takes from the body.
	 */
	readonly trustedCountry: () => Promise<string | null>
	/** Whole-number PPP percent for a country; 0 when it has none. */
	readonly pppPercent: (country: string) => number
	readonly price: (request: PriceRequestData) => {
		ok: boolean
		value?: PricingResultData
	}
	readonly engineVersion: string
	readonly now: () => Date
	/**
	 * The C5 switch: true, C5 is closed, never priced by the legacy path. Read
	 * on every decision; it must resolve true when it cannot tell.
	 */
	readonly disabled: () => boolean | Promise<boolean>
}

const known = <A>(value: A, sourceRefs: readonly string[]): FactData<A> => ({
	value,
	sourceRefs,
})
const gap = <A>(
	reason: 'FactsUnavailable' | 'IdentityUnverified',
): FactData<A> => ({ gap: reason })

/** The PPP fact: trusted country, the buyer's consent, and legacy eligibility. */
export function pppFact({
	orderKind,
	country,
	percent,
	accepted,
	hasValidPurchase,
}: {
	orderKind: 'individual' | 'team'
	country: string | null
	percent: number
	accepted: boolean
	/** Null: unknown. Anonymous display passes false (provisional). */
	hasValidPurchase: boolean | null
}): BuyerFactsData['ppp'] {
	// A team order is never regional; the engine ignores PPP for it anyway.
	if (orderKind === 'team') return known(null, ['ppp:team-order'])
	if (country === null) return gap('FactsUnavailable')
	if (percent <= 0) return known(null, [`geo:country:${country}`])
	if (hasValidPurchase === null) return gap('FactsUnavailable')
	// Legacy PPP: any Valid purchase means the buyer already paid full price.
	if (hasValidPurchase) return known(null, ['ai-hero:ppp:valid-purchase'])
	return known({ accepted, percent }, [`geo:country:${country}`])
}

function anonymousFacts(
	orderKind: 'individual' | 'team',
): Omit<BuyerFactsData, 'ppp'> {
	return {
		order: known(orderKind, ['request:orderKind']),
		alumni: gap('IdentityUnverified'),
		credit: gap('IdentityUnverified'),
		creditUse: gap('IdentityUnverified'),
		legend: gap('IdentityUnverified'),
		// A team's existing seats can only lower its band, so zero is the upper
		// bound an anonymous display can show.
		existingSeats:
			orderKind === 'team'
				? known(0, ['display:anonymous-provisional'])
				: gap('IdentityUnverified'),
	}
}

/**
 * Course Builder's authoritative-price hook for AI Hero: Cohort 005 is priced in-process
 * by front-desk's engine; every other product returns an explicit `null` and
 * keeps Course Builder's legacy path.
 *
 * The hook prices; it never authorizes. AI Hero's route refuses blocked
 * buyers and synthetic principals before any pricing runs.
 */
export function createC5AuthoritativePrice(deps: C5PricingDeps) {
	return async function authoritativePrice(
		request: AuthoritativePriceRequest,
	): Promise<AuthoritativeDecision | null> {
		if (request.productId !== C5_PRODUCT_ID) return null

		const quantity = request.quantity
		const userId = request.userId ?? null
		const base = {
			productId: request.productId,
			quantity,
			userId,
			engineVersion: deps.engineVersion,
		}
		if (await deps.disabled())
			return refusal('closed', [APP_REASONS.killSwitch], base)

		const policy = await deps.policy(request.productId)
		if (!policy.ok)
			return refusal('held', [APP_REASONS.policyUnavailable], base)

		const orderKind = quantity > 1 ? 'team' : 'individual'
		const buyer = await deps.buyer({
			userId,
			productId: request.productId,
			quantity,
			orderKind,
			purpose: request.purpose,
		})
		const withPolicy = { ...base, policyVersion: policy.value.version }
		if (buyer.kind === 'unavailable')
			return refusal('held', [APP_REASONS.factsUnavailable], withPolicy)
		// No upgrade path: a regional holder reaches unrestricted access through
		// support, and is never sold the product a second time.
		if (
			buyer.kind === 'buyer' &&
			orderKind === 'individual' &&
			buyer.holdsRestrictedPurchase
		)
			return refusal('held', [APP_REASONS.restrictedHolder], withPolicy)

		const product = buyer.kind === 'buyer' ? buyer.facts.product : buyer.product
		// Course Builder resolved the price it will charge; the facts must be
		// about that same price row.
		if (request.priceId && product.merchantPriceId !== request.priceId)
			return refusal('held', [APP_REASONS.priceMismatch], withPolicy)

		const country = await deps.trustedCountry()
		const percent = country ? deps.pppPercent(country) : 0
		const ppp = pppFact({
			orderKind,
			country,
			percent,
			accepted: request.pppAccepted,
			hasValidPurchase: buyer.kind === 'buyer' ? buyer.hasValidPurchase : false,
		})
		const facts: BuyerFactsData =
			buyer.kind === 'buyer'
				? { ...buyer.facts.facts, ppp }
				: { ...anonymousFacts(orderKind), ppp }

		const appReasons: string[] = []
		let quotes: readonly BindingQuoteData[] = []
		if (buyer.kind === 'buyer') {
			const read = await deps.quotes({
				email: buyer.email,
				productId: request.productId,
				quantity,
				fresh: request.purpose === 'checkout',
			})
			if (read.ok) quotes = read.value
			// A quote only lowers a price. Without a fresh answer, checkout holds
			// the personalized price instead of charging the formula.
			else if (request.purpose === 'checkout')
				return refusal(
					'held',
					[APP_REASONS.quotesUnavailableAtCheckout],
					withPolicy,
				)
			else appReasons.push(APP_REASONS.quotesUnavailable)
		}

		const priced = deps.price({
			facts,
			now: deps.now().toISOString(),
			product: {
				id: policy.value.policy.product,
				merchantUnit: product.merchantUnit,
				policy: policy.value.policy,
			},
			quantity,
			quotes,
		})
		if (!priced.ok || !priced.value)
			return refusal('held', [APP_REASONS.factsUnavailable], withPolicy)

		let decision = toAuthoritativeDecision(priced.value, {
			...base,
			purpose: request.purpose,
			policy: policy.value.policy,
			pppPercent: ppp && 'value' in ppp && ppp.value ? ppp.value.percent : null,
			appReasons,
		})
		if (buyer.kind === 'anonymous')
			decision = provisional(decision, APP_REASONS.identityRequired)
		if (appReasons.includes(APP_REASONS.quotesUnavailable))
			decision = provisional(decision, APP_REASONS.quotesUnavailable)
		return decision
	}
}
