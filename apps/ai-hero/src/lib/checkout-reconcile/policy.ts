/**
 * Pure rules for the checkout reconciler.
 *
 * Incident 2026-10-09: Stripe's webhook returned 200 and Inngest accepted the
 * `stripe/checkout-session-completed` event, then created zero runs. The
 * core function keys idempotency on the checkout session id for 24 hours, so
 * a replay of the same session is dropped too. The reconciler finds paid
 * sessions with no purchase and fulfills them by calling the same handler
 * directly. Everything here is side-effect free so the sweep, the fulfill
 * function and `checkout:recover --direct` share one definition of "stranded".
 *
 * @module checkout-reconcile/policy
 */
import type Stripe from 'stripe'

/** A paid session gets this long to be fulfilled by the normal path. */
export const CHECKOUT_RECONCILE_MIN_AGE_MS = 5 * 60_000

/** The sweep looks this far back in Stripe. */
export const CHECKOUT_RECONCILE_WINDOW_MS = 48 * 60 * 60_000

/**
 * A session still stranded this long after completion means the reconciler's
 * own fulfillment did not land. The sweep escalates instead of retrying,
 * because the fulfill function's idempotency key is spent for 24 hours.
 */
export const CHECKOUT_RECONCILE_OVERDUE_MS = 30 * 60_000

/** Kill switch. Truthy means alert-only: detect and alert, never fulfill. */
export const CHECKOUT_RECONCILE_KILL_SWITCH_ENV =
	'AIH_CHECKOUT_RECONCILER_AUTO_FULFILL_DISABLED'

/** Marker on the error the guarded adapter throws when a purchase appeared. */
export const CHECKOUT_RECONCILE_ALREADY_FULFILLED =
	'CHECKOUT_RECONCILE_ALREADY_FULFILLED'

/** Auto-fulfill is on unless the kill switch is set to `true` or `1`. */
export function checkoutAutoFulfillEnabled(
	source: Record<string, string | undefined> = process.env,
): boolean {
	const value = String(source[CHECKOUT_RECONCILE_KILL_SWITCH_ENV] ?? '')
		.trim()
		.toLowerCase()
	return !['true', '1'].includes(value)
}

/** The fulfill function's idempotency key, distinct from the core function's. */
export function checkoutReconcileKey(checkoutSessionId: string) {
	return `checkout-reconcile:${checkoutSessionId}`
}

/** The slice of a Stripe session the sweep keeps in step output. */
export type CheckoutSessionSummary = {
	id: string
	created: number
	mode: string | null
	status: string | null
	paymentStatus: string | null
	amountTotal: number | null
	siteName: string | null
	/** Present when the list call expanded `data.payment_intent`. */
	chargeId: string | null
}

export function summarizeCheckoutSession(
	session: Pick<
		Stripe.Checkout.Session,
		| 'id'
		| 'created'
		| 'mode'
		| 'status'
		| 'payment_status'
		| 'amount_total'
		| 'metadata'
		| 'payment_intent'
	>,
): CheckoutSessionSummary {
	const paymentIntent = session.payment_intent
	const latestCharge =
		paymentIntent && typeof paymentIntent !== 'string'
			? paymentIntent.latest_charge
			: null
	return {
		id: session.id,
		created: session.created,
		mode: session.mode ?? null,
		status: session.status ?? null,
		paymentStatus: session.payment_status ?? null,
		amountTotal: session.amount_total ?? null,
		siteName: session.metadata?.siteName ?? null,
		chargeId:
			typeof latestCharge === 'string' ? latestCharge : (latestCharge?.id ?? null),
	}
}

export type CheckoutSessionSkipReason =
	| 'not_payment_mode'
	| 'not_complete'
	| 'not_paid'
	| 'zero_total'
	| 'other_site'
	| 'too_young'
	| 'outside_window'

export type CheckoutSessionVerdict =
	| { kind: 'candidate'; ageMs: number }
	| { kind: 'skip'; reason: CheckoutSessionSkipReason }

/**
 * Decides whether a Stripe session is one this app should have fulfilled.
 *
 * Mirrors the webhook: only `payment` mode reaches the core function, and a
 * zero-total payment session is quarantined there on purpose, so it never
 * gets a purchase and is never stranded. `siteName` is stamped by this app's
 * checkout; a session from another site, or with no stamp, is not ours to
 * fulfill.
 */
export function classifyCheckoutSession(
	session: CheckoutSessionSummary,
	options: {
		now: Date
		appName: string
		minAgeMs?: number
		windowMs?: number
	},
): CheckoutSessionVerdict {
	const minAgeMs = options.minAgeMs ?? CHECKOUT_RECONCILE_MIN_AGE_MS
	const windowMs = options.windowMs ?? CHECKOUT_RECONCILE_WINDOW_MS
	if (session.mode !== 'payment') return skip('not_payment_mode')
	if (session.status !== 'complete') return skip('not_complete')
	if (session.paymentStatus !== 'paid') return skip('not_paid')
	if (!session.amountTotal) return skip('zero_total')
	if (session.siteName !== options.appName) return skip('other_site')
	const ageMs = options.now.getTime() - session.created * 1000
	if (ageMs > windowMs) return skip('outside_window')
	if (ageMs < minAgeMs) return skip('too_young')
	return { kind: 'candidate', ageMs }
}

function skip(reason: CheckoutSessionSkipReason): CheckoutSessionVerdict {
	return { kind: 'skip', reason }
}

export type CheckoutChargeState = {
	chargeId: string | null
	/** False when the charge was not expanded, so refund state is unknown. */
	expanded: boolean
	refunded: boolean
	disputed: boolean
	amountRefunded: number
}

/**
 * Reads the charge from a session retrieved with
 * `payment_intent.latest_charge` expanded, as `getCheckoutSession` does.
 */
export function checkoutChargeState(
	session: Pick<Stripe.Checkout.Session, 'payment_intent'>,
): CheckoutChargeState {
	const paymentIntent = session.payment_intent
	const charge =
		paymentIntent && typeof paymentIntent !== 'string'
			? paymentIntent.latest_charge
			: null
	if (!charge || typeof charge === 'string') {
		return {
			chargeId: charge ?? null,
			expanded: false,
			refunded: false,
			disputed: false,
			amountRefunded: 0,
		}
	}
	return {
		chargeId: charge.id,
		expanded: true,
		refunded: charge.refunded || charge.amount_refunded > 0,
		disputed: Boolean(charge.disputed),
		amountRefunded: charge.amount_refunded ?? 0,
	}
}
