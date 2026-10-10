import 'server-only'

import { hooks as frontDeskHooks } from '@/app/api/front-desk/hooks'
import { db } from '@/db'
import { prices, purchases, users } from '@/db/schema'
import { env } from '@/env.mjs'
import { log } from '@/server/logger'
import { recordCheckoutDecision } from '@/lib/buy-path/checkout-context'
import { ENGINE_VERSION, price } from '@ai-hero/front-desk-support/pricing'
import { and, eq } from 'drizzle-orm'

import { getPPPDiscountPercent } from '@coursebuilder/commerce/parity-coupon'
import type { AuthoritativePriceRequest } from '@coursebuilder/core/schemas'

import { c5PricingDisabled } from './config'
import { createFrontDeskData, type FrontDeskData } from './front-desk-data'
import { createC5AuthoritativePrice, type BuyerRead } from './hook'
import { holdsRestrictedPurchase } from './restricted-holder'
import { trustedPricingCountry } from './trusted-country'

/** Display reuses a buyer's facts this long; checkout always reads fresh. */
const DISPLAY_FACTS_TTL_MS = 60_000
const DISPLAY_FACTS_LIMIT = 500

let data: FrontDeskData | null | undefined
/** front-desk's policy and quote reads, or null until it is configured. */
export function frontDeskData(): FrontDeskData | null {
	if (data === undefined)
		data =
			env.FRONT_DESK_URL && env.FRONT_DESK_PRICING_TOKEN
				? createFrontDeskData({
						url: env.FRONT_DESK_URL,
						pricingToken: env.FRONT_DESK_PRICING_TOKEN,
						quotesToken: env.FRONT_DESK_QUOTES_TOKEN,
					})
				: null
	return data
}

async function singleActivePrice(productId: string) {
	const rows = await db
		.select({ id: prices.id, unitAmount: prices.unitAmount })
		.from(prices)
		.where(and(eq(prices.productId, productId), eq(prices.status, 1)))
	const [row] = rows
	if (rows.length !== 1 || !row) return null
	return {
		appProductId: productId,
		merchantPriceId: row.id,
		merchantUnit: Math.round(Number(row.unitAmount) * 100),
		sourceRefs: [`ai-hero:price:${row.id}`],
	}
}

async function readBuyer(input: {
	userId: string | null
	productId: string
	quantity: number
	orderKind: 'individual' | 'team'
}): Promise<BuyerRead> {
	try {
		if (!input.userId) {
			const product = await singleActivePrice(input.productId)
			return product
				? { kind: 'anonymous', product }
				: { kind: 'unavailable', reason: 'no-single-active-price' }
		}
		const [user] = await db
			.select({ email: users.email })
			.from(users)
			.where(eq(users.id, input.userId))
			.limit(1)
		if (!user?.email) return { kind: 'unavailable', reason: 'user-missing' }
		const facts = await frontDeskHooks.pricingFacts({
			email: user.email,
			productId: input.productId,
			quantity: input.quantity,
			orderKind: input.orderKind,
		})
		// The exact-email lookup must land on the same account, or these facts
		// are someone else's.
		if (!facts || facts.buyer.userId !== input.userId)
			return { kind: 'unavailable', reason: 'identity-mismatch' }
		const [[valid], restricted] = await Promise.all([
			db
				.select({ id: purchases.id })
				.from(purchases)
				.where(
					and(
						eq(purchases.userId, input.userId),
						eq(purchases.status, 'Valid'),
					),
				)
				.limit(1),
			holdsRestrictedPurchase(input.userId, input.productId),
		])
		return {
			kind: 'buyer',
			email: user.email,
			facts,
			hasValidPurchase: Boolean(valid),
			holdsRestrictedPurchase: restricted,
		}
	} catch {
		return { kind: 'unavailable', reason: 'facts-read-failed' }
	}
}

const displayFacts = new Map<string, { at: number; read: Promise<BuyerRead> }>()

function buyerFor(input: {
	userId: string | null
	productId: string
	quantity: number
	orderKind: 'individual' | 'team'
	purpose: 'display' | 'checkout'
}): Promise<BuyerRead> {
	const { purpose, ...request } = input
	if (purpose === 'checkout') return readBuyer(request)
	const key = JSON.stringify(request)
	const now = Date.now()
	const cached = displayFacts.get(key)
	if (cached && now - cached.at < DISPLAY_FACTS_TTL_MS) return cached.read
	if (displayFacts.size >= DISPLAY_FACTS_LIMIT)
		displayFacts.delete(displayFacts.keys().next().value!)
	const read = readBuyer(request).then((result) => {
		// Never keep a failure: the next view tries again.
		if (result.kind === 'unavailable') displayFacts.delete(key)
		return result
	})
	displayFacts.set(key, { at: now, read })
	return read
}

const decide = createC5AuthoritativePrice({
	policy: async (productId) =>
		frontDeskData()?.policy(productId) ?? {
			ok: false,
			reason: 'front-desk-not-configured',
		},
	quotes: async (input) =>
		frontDeskData()?.bindingQuotes(input) ?? {
			ok: false,
			reason: 'front-desk-not-configured',
		},
	buyer: buyerFor,
	trustedCountry: trustedPricingCountry,
	pppPercent: (country) => Math.round(getPPPDiscountPercent(country) * 100),
	price,
	engineVersion: ENGINE_VERSION,
	now: () => new Date(),
	disabled: c5PricingDisabled,
})

/** AI Hero's authoritative-price hook, as Course Builder calls it. */
export async function c5AuthoritativePrice(request: AuthoritativePriceRequest) {
	const decision = await decide(request)
	if (decision && request.purpose === 'checkout') {
		await log.info('c5.pricing.checkout_decision', {
			buyPathId: recordCheckoutDecision(decision.kind),
			productId: request.productId,
			quantity: request.quantity,
			userId: request.userId ?? null,
			kind: decision.kind,
			amountCents: decision.amountCents,
			restriction: decision.restriction,
			reasons: decision.reasons,
			decisionRef: decision.decisionRef,
			policyVersion: decision.policyVersion,
			engineVersion: decision.engineVersion,
		})
	}
	return decision
}
