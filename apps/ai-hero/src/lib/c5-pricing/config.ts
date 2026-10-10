import { env } from '@/env.mjs'

/**
 * When paid C5 purchases started saving their pricing decisions. Credit use
 * reads saved decisions after it and the transfer-chain fallback before it.
 * Null when unset: a buyer whose chain has any C5 purchase is then held.
 */
export function c5DecisionCutover(
	value: string | undefined = env.AIH_C5_DECISION_CUTOVER_AT,
): Date | null {
	if (!value) return null
	const at = new Date(value)
	return Number.isNaN(at.getTime()) ? null : at
}

/**
 * The C5 kill switch. Any value but unset, empty or "false" closes C5, so a
 * mistyped value fails closed instead of failing the build.
 */
export function c5PricingDisabled(
	value: string | undefined = env.AIH_C5_PRICING_DISABLED,
): boolean {
	const normalized = value?.trim().toLowerCase()
	return Boolean(normalized) && normalized !== 'false'
}
