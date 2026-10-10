import { createHash } from 'node:crypto'
import type {
	PricingPolicyData,
	PricingResultData,
} from '@ai-hero/front-desk-support/pricing'

import type { AuthoritativeDecision } from '@coursebuilder/core/schemas'

import { C5_PRODUCT_ID } from './products'
import { APP_REASONS } from './reasons'

export { APP_REASONS } from './reasons'
export { AUTHORITATIVE_PRODUCT_IDS, C5_PRODUCT_ID } from './products'

/**
 * `decisionRef` names a decision and carries the one thing fulfillment needs
 * besides the versions: which Crash Course purchase's credit it spent.
 * `c5d1.<hash>.<credit source or ->`, well under Stripe's 500-character cap.
 */
const REF_PREFIX = 'c5d1'

export function encodeDecisionRef(
	hash: string,
	creditSource: string | null,
): string {
	return [
		REF_PREFIX,
		hash,
		creditSource === null ? '-' : encodeURIComponent(creditSource),
	].join('.')
}

export function decodeDecisionRef(
	ref: string,
): { hash: string; creditSource: string | null } | null {
	const parts = ref.split('.')
	if (parts.length !== 3 || parts[0] !== REF_PREFIX) return null
	const [, hash, credit] = parts
	if (!hash || !/^[0-9a-f]{16}$/.test(hash) || !credit) return null
	try {
		return {
			hash,
			creditSource: credit === '-' ? null : decodeURIComponent(credit),
		}
	} catch {
		return null
	}
}

/** Stable JSON: keys sorted, so equal decisions hash equally. */
function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
	if (value && typeof value === 'object')
		return `{${Object.keys(value)
			.sort()
			.map(
				(key) =>
					`${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
			)
			.join(',')}}`
	return JSON.stringify(value) ?? 'null'
}

const shortHash = (value: unknown) =>
	createHash('sha256').update(canonical(value)).digest('hex').slice(0, 16)

export type DecisionContext = {
	readonly productId: string
	readonly quantity: number
	readonly userId: string | null
	readonly purpose: 'display' | 'checkout'
	readonly policy: PricingPolicyData | null
	readonly engineVersion: string
	/** Whole-number PPP percent from the buyer's trusted country, if eligible. */
	readonly pppPercent: number | null
	/** App reasons added to the engine's reasons. */
	readonly appReasons?: readonly string[]
}

/** A decision with no purchasable price and no engine run behind it. */
export function refusal(
	kind: 'not-open' | 'closed' | 'held',
	reasons: readonly string[],
	context: Pick<
		DecisionContext,
		'productId' | 'quantity' | 'userId' | 'engineVersion'
	> & { readonly policyVersion?: string | null },
): AuthoritativeDecision {
	const policyVersion = context.policyVersion || 'unavailable'
	return {
		kind,
		amountCents: 0,
		unitAmountCents: 0,
		restriction: 'none',
		offers: [],
		reasons: [...reasons],
		decisionRef: encodeDecisionRef(
			shortHash({
				kind,
				reasons,
				productId: context.productId,
				quantity: context.quantity,
				userId: context.userId,
				policyVersion,
				engineVersion: context.engineVersion,
			}),
			null,
		),
		engineVersion: context.engineVersion,
		policyVersion,
	}
}

/** Epoch ms at which hosted checkout stops, when the policy has ruled it. */
export function checkoutStopsAt(policy: PricingPolicyData | null) {
	const ruling = policy?.checkoutStopsAt
	if (!ruling || !('value' in ruling)) return undefined
	const at = Date.parse(ruling.value)
	return Number.isFinite(at) && at > 0 ? at : undefined
}

/** A discount off the order's list total, as the fraction Course Builder expects. */
function fractionOff(amount: number, listTotal: number) {
	if (listTotal <= 0 || amount >= listTotal) return 0
	return Math.round((1 - amount / listTotal) * 100) / 100
}

/**
 * Maps the engine's result onto Course Builder's `AuthoritativeDecision`.
 *
 * - Money stays in integer cents. The engine's whole-number percents become
 *   Course Builder's 0..1 fractions: a PPP offer carries the buyer's PPP percent / 100.
 * - `priced` and `bounded` keep their kind: only `priced` is ever charged.
 * - `closesAt` is when hosted checkout stops, so no session outlives it.
 */
export function toAuthoritativeDecision(
	result: PricingResultData,
	context: DecisionContext,
): AuthoritativeDecision {
	const appReasons = context.appReasons ?? []
	const reasons = [
		...result.reasons.map((reason) => reason.code),
		...appReasons,
	]
	if (
		result.kind === 'not-open' ||
		result.kind === 'closed' ||
		result.kind === 'held'
	) {
		return {
			...refusal(result.kind, reasons, {
				...context,
				policyVersion: context.policy?.version,
			}),
			...withCloses(context.policy),
		}
	}
	const listTotal = (context.policy?.list ?? 0) * context.quantity
	const unitAmountCents =
		result.unitAmount ?? Math.round(result.amount / context.quantity)
	const offers = result.offers.map((offer) => ({
		amountCents: offer.amount,
		percent:
			offer.basis === 'ppp' && context.pppPercent !== null
				? context.pppPercent / 100
				: fractionOff(offer.amount, listTotal),
		restriction: offer.restriction,
	}))
	const core = {
		kind: result.kind,
		amountCents: result.amount,
		unitAmountCents,
		restriction: result.restriction,
		rule: result.rule,
		basis: result.basis,
		creditSource: result.creditSource,
		quoteRefs: result.quoteRefs,
		offers,
		productId: context.productId,
		quantity: context.quantity,
		userId: context.userId,
		policyVersion: result.policyVersion,
		engineVersion: result.engineVersion,
	}
	return {
		kind: result.kind,
		amountCents: result.amount,
		unitAmountCents,
		restriction: result.restriction,
		offers,
		reasons,
		decisionRef: encodeDecisionRef(shortHash(core), result.creditSource),
		engineVersion: result.engineVersion,
		policyVersion: result.policyVersion,
		...withCloses(context.policy),
	}
}

function withCloses(policy: PricingPolicyData | null) {
	const closesAt = checkoutStopsAt(policy)
	return closesAt === undefined ? {} : { closesAt }
}

/**
 * The anonymous display price is the new-buyer price, provisional: it is an
 * upper bound until a signed-in buyer's facts are known, so it never reads as
 * a charge.
 */
export function provisional(
	decision: AuthoritativeDecision,
	reason: string,
): AuthoritativeDecision {
	if (decision.kind !== 'priced' && decision.kind !== 'bounded') return decision
	return {
		...decision,
		kind: 'bounded',
		reasons: decision.reasons.includes(reason)
			? decision.reasons
			: [...decision.reasons, reason],
	}
}
