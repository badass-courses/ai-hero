import type { FormattedPrice } from '@coursebuilder/commerce'

import { APP_REASONS } from './reasons'

/**
 * What a pricing surface may do with a formatted price. Course Builder's stock
 * buy button only knows pending, error and sold out, so a `bounded` or closed
 * authoritative decision would stay clickable; every buy button reads this.
 *
 * - `buy`: a legacy price or a chargeable decision.
 * - `sign-in`: nobody is signed in, so the price is an upper bound. The button
 *   stays enabled because checkout sends an anonymous buyer to sign in first
 *   and prices them fresh there; it never charges the bound.
 * - `blocked`: no purchasable price. The button is disabled.
 */
export type PurchaseGate =
	| { kind: 'buy'; upperBound: false }
	| { kind: 'sign-in'; upperBound: true; label: string }
	| { kind: 'blocked'; upperBound: boolean; label: string }

const BLOCKED_LABEL: Record<string, string> = {
	'not-open': 'Not open yet',
	closed: 'Enrollment closed',
	held: 'Price unavailable',
	bounded: 'Price unavailable',
}

export function purchaseGate(
	formattedPrice: Pick<FormattedPrice, 'authoritative'> | null | undefined,
): PurchaseGate {
	const decision = formattedPrice?.authoritative
	if (!decision || decision.purchasable)
		return { kind: 'buy', upperBound: false }
	if (
		decision.kind === 'bounded' &&
		decision.reasons.includes(APP_REASONS.identityRequired)
	) {
		return { kind: 'sign-in', upperBound: true, label: 'Sign in to buy' }
	}
	return {
		kind: 'blocked',
		upperBound: decision.isUpperBound,
		label: BLOCKED_LABEL[decision.kind] ?? 'Price unavailable',
	}
}
