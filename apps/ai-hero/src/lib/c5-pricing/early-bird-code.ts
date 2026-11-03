import type { PricingPolicyData } from '@ai-hero/front-desk-support/pricing'

import { C5_PRODUCT_ID } from './products'

/**
 * An early-bird code is an ordinary merchant coupon row scoped to Cohort 005
 * whose percentage equals the policy's new-buyer early percent. A buyer who
 * presents one is priced as if the early window were still open for them,
 * until the code expires. The engine then does the rest exactly as it did
 * before the deadline: the early percent off list, then the Crash Course
 * credit, with the credit recorded as spent. No new price shape exists.
 *
 * The browser only carries the coupon id. Every price reads the row fresh, so
 * switching a code off or letting it expire takes effect on the next price.
 */
export const EARLY_BIRD_CODE_COOKIE = 'c5_early_bird_code'
export const EARLY_BIRD_CODE_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 14
const COUPON_ID = /^coupon_[a-z0-9]{3,40}$/i

/** Only a well-formed coupon id is ever stored or looked up. */
export function earlyBirdCouponId(value: string | null | undefined) {
	return value && COUPON_ID.test(value) ? value : null
}

/**
 * Course Builder refuses checkout within 30 minutes of a decision's closesAt;
 * one more minute keeps a quote from promising what checkout then refuses.
 */
export const EARLY_BIRD_CHECKOUT_CUTOFF_MS = 31 * 60 * 1000

export const EARLY_BIRD_CODE_REASONS = {
	/** A valid early-bird code priced this buyer in the early window. */
	applied: 'early-bird-code-applied',
	/** The buyer's early-bird code has expired or been switched off. */
	ended: 'early-bird-code-ended',
} as const

export type EarlyBirdCouponRow = {
	readonly id: string
	readonly status: number
	readonly expires: Date | null
	readonly maxUses: number
	readonly usedCount: number
	readonly percentageDiscount: string | number | null
	readonly amountDiscount: string | number | null
	readonly restrictedToProductId: string | null
	readonly organizationId: string | null
	readonly fields: unknown
}

export type EarlyBirdCode =
	| { readonly state: 'none' }
	| { readonly state: 'ended'; readonly couponId: string }
	| {
			readonly state: 'valid'
			readonly couponId: string
			readonly expiresAt: number
	  }

export type EarlyBirdCodeRead = () => Promise<EarlyBirdCodeRow>
export type EarlyBirdCodeRow =
	| { readonly couponId: null }
	| { readonly couponId: string; readonly row: EarlyBirdCouponRow | null }

const ruledNumber = (ruling: { value: number } | { question: string }) =>
	'value' in ruling ? ruling.value : null
const ruledInstant = (ruling: { value: string } | { question: string }) => {
	if (!('value' in ruling)) return null
	const at = Date.parse(ruling.value)
	return Number.isFinite(at) ? at : null
}

const isLegendGift = (fields: unknown) => {
	let value = fields
	if (typeof value === 'string') {
		try {
			value = JSON.parse(value)
		} catch {
			return false
		}
	}
	return (
		typeof value === 'object' &&
		value !== null &&
		(value as { purpose?: unknown }).purpose === 'legend-gift'
	)
}

/**
 * Classifies the presented code against the live policy. A code with no
 * expiry is never honoured: an unbounded early bird is a price change nobody
 * approved. Legend gift codes keep their own path.
 */
export function classifyEarlyBirdCode(
	read: EarlyBirdCodeRow,
	policy: PricingPolicyData,
	now: number,
): EarlyBirdCode {
	if (read.couponId === null) return { state: 'none' }
	// Inside the published early window everyone already has the early price;
	// a code there changes nothing, not even the session's close.
	const earlyEnds = ruledInstant(policy.earlyEndsAt)
	if (earlyEnds === null || now < earlyEnds) return { state: 'none' }
	const { couponId, row } = read
	if (!row || row.id !== couponId) return { state: 'none' }
	if (row.restrictedToProductId !== C5_PRODUCT_ID) return { state: 'none' }
	if (row.organizationId !== null || isLegendGift(row.fields))
		return { state: 'none' }
	if (row.amountDiscount !== null && Number(row.amountDiscount) > 0)
		return { state: 'none' }
	const early = ruledNumber(policy.newBuyerEarlyPercent)
	const percent = Math.round(Number(row.percentageDiscount ?? 0) * 100)
	if (early === null || early <= 0 || percent !== early) return { state: 'none' }
	// Only unlimited codes. Checkout spends a generated one-use Stripe discount
	// and never debits this row, so a use limit here would not be enforced.
	if (row.maxUses !== -1) return { state: 'none' }
	if (row.status !== 1) return { state: 'ended', couponId }
	const expiresAt = row.expires?.getTime() ?? null
	if (expiresAt === null || !Number.isFinite(expiresAt))
		return { state: 'none' }
	// Course Builder refuses a new session close to its closesAt, which is the
	// code's expiry, so the code reads as ended from that cutoff on.
	if (now >= expiresAt - EARLY_BIRD_CHECKOUT_CUTOFF_MS)
		return { state: 'ended', couponId }
	return { state: 'valid', couponId, expiresAt }
}

/**
 * The policy the engine prices this one buyer with: the early window runs to
 * the code's expiry, never past enrollment close and never shorter than the
 * published early window. Everything else is the live policy unchanged.
 */
export function withEarlyBirdWindow(
	policy: PricingPolicyData,
	code: Extract<EarlyBirdCode, { state: 'valid' }>,
): PricingPolicyData {
	const earlyEnds = ruledInstant(policy.earlyEndsAt)
	const closes = ruledInstant(policy.closesAt)
	if (earlyEnds === null || closes === null || !('value' in policy.earlyEndsAt))
		return policy
	const until = Math.max(earlyEnds, Math.min(code.expiresAt, closes))
	if (until === earlyEnds) return policy
	return {
		...policy,
		earlyEndsAt: {
			source: `${policy.earlyEndsAt.source}; early-bird code ${code.couponId}`,
			value: new Date(until).toISOString(),
		},
	}
}
