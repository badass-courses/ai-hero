import type {
	PricingPolicyData,
	PricingResultData,
} from '@ai-hero/front-desk-support/pricing'

import type {
	AuthoritativeDecision,
	AuthoritativePriceRequest,
} from '@coursebuilder/core/schemas'

import { APP_REASONS } from './reasons'

/**
 * The one `bounded` C5 price a buyer may pay. Engine 0.2.0 takes the Crash
 * Course credit off the regional (PPP) price, so a buyer whose credit is still
 * unresolved gets `bounded` with today's regional price as its upper bound.
 * Under Joel's hotfix-and-backfill ruling (2026-10-26) checkout charges that
 * bound, and the backfill refunds the difference once the credit resolves.
 *
 * Front-desk's exact signature, matched in full and nothing broader:
 * - engine 0.2 or later, under a policy that rules `creditOffPpp` true
 *   (`creditOffRegional`)
 * - kind `bounded`; rule, basis and restriction `ppp`, `ppp`, `region`
 * - no credit source, and a whole positive amount
 * - exactly one unresolved entry: candidate `credit`, fact `credit`, any gap
 * - one `fact-unknown` reason, for `credit:`, and otherwise only window,
 *   selection and set-aside quote reasons
 */
const ALLOWED_REASONS: ReadonlySet<string> = new Set([
	'early-window',
	'standard-window',
	'selected',
	// A quote the engine set aside cannot lower the price. An unreadable quote
	// basis could, so `quote-basis-unknown` stays blocked.
	'quote-expired',
	'quote-out-of-scope',
])

/**
 * Whether the credit comes off the regional price. Engine 0.1 never takes it
 * off, and 0.2 only when the policy rules `creditOffPpp` true. Otherwise the
 * same signature can resolve to a cheaper unrestricted price, and a refund
 * cannot undo a region restriction. With the credit off both prices, the
 * regional price stays the winner and only the amount moves.
 */
function creditOffRegional(
	engineVersion: string,
	policy: Pick<PricingPolicyData, 'creditOffPpp'>,
) {
	const ruling = policy.creditOffPpp
	if (!ruling || !('value' in ruling) || ruling.value !== true) return false
	const [major, minor] = engineVersion.split('.').map(Number)
	if (!Number.isInteger(major) || !Number.isInteger(minor)) return false
	return major! > 0 || minor! >= 2
}

export function isPppCreditBound(
	result: PricingResultData,
	policy: Pick<PricingPolicyData, 'creditOffPpp'>,
): result is Extract<PricingResultData, { kind: 'bounded' }> {
	if (result.kind !== 'bounded') return false
	if (
		!creditOffRegional(result.engineVersion, policy) ||
		result.rule !== 'ppp' ||
		result.basis !== 'ppp' ||
		result.restriction !== 'region' ||
		result.creditSource !== null ||
		!Number.isSafeInteger(result.amount) ||
		result.amount <= 0
	)
		return false
	const [unresolved, ...more] = result.unresolved
	if (
		!unresolved ||
		more.length ||
		unresolved.candidate !== 'credit' ||
		unresolved.fact !== 'credit'
	)
		return false
	const factUnknown = result.reasons.filter(
		(reason) => reason.code === 'fact-unknown',
	)
	if (factUnknown.length !== 1 || !factUnknown[0]?.detail.startsWith('credit:'))
		return false
	return result.reasons.every(
		(reason) =>
			reason.code === 'fact-unknown' || ALLOWED_REASONS.has(reason.code),
	)
}

export const PPP_CREDIT_BOUND_EVENT =
	'c5.pricing.ppp_credit_unresolved_charged_bound'

/**
 * What the backfill needs to find a checkout that charged the bound. The
 * decision ref travels in the Checkout Session metadata, so it joins this
 * event to the purchase. Null for every other decision.
 */
export function pppCreditBoundCharge(
	request: Pick<AuthoritativePriceRequest, 'productId' | 'userId' | 'purpose'>,
	decision: AuthoritativeDecision | null,
) {
	if (
		request.purpose !== 'checkout' ||
		decision?.kind !== 'priced' ||
		!decision.reasons.includes(APP_REASONS.pppCreditBound)
	)
		return null
	return {
		productId: request.productId,
		userId: request.userId ?? null,
		amountCents: decision.amountCents,
		restriction: decision.restriction,
		decisionRef: decision.decisionRef,
		policyVersion: decision.policyVersion,
		engineVersion: decision.engineVersion,
	}
}
