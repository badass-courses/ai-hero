/**
 * Direct checkout fulfillment, shared by the reconciler's Inngest function
 * and `checkout:recover --direct`.
 *
 * It calls the registered `stripe-checkout-session-completed` handler with
 * a caller-supplied `step`, instead of sending another event that Inngest
 * could drop again. Inside Inngest the caller passes the run's real `step`,
 * so the handler's steps are memoized and retried like a normal run. The CLI
 * passes a plain shim.
 *
 * Exactly-once rests on three layers:
 *
 *   1. A re-check before the handler runs: any purchase linked to the session
 *      or its charge means there is nothing to do.
 *   2. A guarded adapter: inside the handler's own write step, immediately
 *      before `createMerchantChargeAndPurchase`, the guard reads again and
 *      throws `CHECKOUT_RECONCILE_ALREADY_FULFILLED` if a purchase appeared.
 *      The handler stops before it sends `new-purchase-created`.
 *   3. The adapter itself: it writes the charge, merchant session and
 *      purchase in one transaction behind a locking read on the charge, and
 *      `MerchantCharge.identifier` is unique. A late original run that loses
 *      the race either adopts the existing purchase or fails on the unique
 *      key. Downstream purchase functions key idempotency on `purchaseId`.
 *
 * @module checkout-reconcile/fulfill
 */
import type Stripe from 'stripe'

import { buildCheckoutCompletedEventData } from './checkout-event'
import type { CheckoutFulfillmentState } from './inspect'
import {
	CHECKOUT_RECONCILE_ALREADY_FULFILLED,
	checkoutChargeState,
	classifyCheckoutSession,
	summarizeCheckoutSession,
	type CheckoutSessionSkipReason,
} from './policy'

export const STRIPE_CHECKOUT_HANDLER_ID = 'stripe-checkout-session-completed'

/** The subset of an Inngest `step` the handler and this module use. */
export type CheckoutFulfillStep = {
	run: <T>(id: string, fn: () => Promise<T>) => Promise<unknown>
	sendEvent: (id: string, payload: any) => Promise<unknown>
}

/** The commerce adapter the handler receives. Only one method is guarded. */
export type CheckoutFulfillDatabase = {
	createMerchantChargeAndPurchase: (options: any) => Promise<any>
	[key: string]: unknown
}

export type CheckoutHandler = (input: any) => Promise<unknown>

export type DirectCheckoutFulfillmentDeps = {
	handler: CheckoutHandler
	step: CheckoutFulfillStep
	db: CheckoutFulfillDatabase
	paymentProvider: unknown
	notificationProvider?: unknown
	getCheckoutSession: (
		checkoutSessionId: string,
	) => Promise<Stripe.Checkout.Session>
	inspect: (input: {
		checkoutSessionId: string
		chargeId: string | null
	}) => Promise<CheckoutFulfillmentState>
	appName: string
	now: () => Date
	/** Becomes the handler's `txnId`, so logs tie back to this path. */
	txnId: string
	/** Sessions younger than this are left to the normal path. */
	minAgeMs?: number
	/** Sessions older than this are out of scope. The CLI lifts it. */
	windowMs?: number
}

export type DirectCheckoutFulfillmentResult =
	| {
			status: 'fulfilled'
			checkoutSessionId: string
			chargeId: string
			purchaseId: string
			state: CheckoutFulfillmentState
	  }
	| {
			status: 'already_fulfilled' | 'raced'
			checkoutSessionId: string
			chargeId: string | null
			purchaseIds: string[]
			state: CheckoutFulfillmentState
	  }
	| {
			status: 'skipped'
			checkoutSessionId: string
			chargeId: string | null
			reason:
				| CheckoutSessionSkipReason
				| 'session_mismatch'
				| 'charge_not_expanded'
				| 'refunded'
				| 'disputed'
	  }

export class CheckoutAlreadyFulfilledError extends Error {
	constructor(readonly purchaseIds: string[]) {
		super(
			`${CHECKOUT_RECONCILE_ALREADY_FULFILLED}: ${purchaseIds.join(',')}`,
		)
		this.name = 'CheckoutAlreadyFulfilledError'
	}
}

function isAlreadyFulfilledError(error: unknown) {
	return (
		error instanceof Error &&
		error.message.includes(CHECKOUT_RECONCILE_ALREADY_FULFILLED)
	)
}

/** Finds the registered core handler, the one the webhook path runs. */
export function findCheckoutHandler(
	functions: readonly { config: { id: string }; handler: unknown }[],
): CheckoutHandler {
	const fn = functions.find(
		(candidate) => candidate.config.id === STRIPE_CHECKOUT_HANDLER_ID,
	)
	if (!fn) throw new Error(`${STRIPE_CHECKOUT_HANDLER_ID} handler not found`)
	return fn.handler as CheckoutHandler
}

/**
 * Fulfills one paid checkout session through the core handler, once.
 *
 * Re-checks every guard against a fresh Stripe read, whatever the caller
 * already checked.
 */
export async function fulfillCheckoutSessionDirectly(
	checkoutSessionId: string,
	deps: DirectCheckoutFulfillmentDeps,
): Promise<DirectCheckoutFulfillmentResult> {
	const session = (await deps.step.run(
		'reconcile: load checkout session',
		() => deps.getCheckoutSession(checkoutSessionId),
	)) as Stripe.Checkout.Session

	if (session.id !== checkoutSessionId) {
		return skipped(checkoutSessionId, null, 'session_mismatch')
	}

	const verdict = classifyCheckoutSession(summarizeCheckoutSession(session), {
		now: deps.now(),
		appName: deps.appName,
		minAgeMs: deps.minAgeMs,
		windowMs: deps.windowMs,
	})
	const charge = checkoutChargeState(session)
	if (verdict.kind === 'skip') {
		return skipped(checkoutSessionId, charge.chargeId, verdict.reason)
	}
	if (!charge.expanded || !charge.chargeId) {
		return skipped(checkoutSessionId, charge.chargeId, 'charge_not_expanded')
	}
	if (charge.refunded) {
		return skipped(checkoutSessionId, charge.chargeId, 'refunded')
	}
	if (charge.disputed) {
		return skipped(checkoutSessionId, charge.chargeId, 'disputed')
	}
	const chargeId = charge.chargeId

	const inspectNow = () => deps.inspect({ checkoutSessionId, chargeId })
	const before = (await deps.step.run(
		'reconcile: re-check fulfillment',
		inspectNow,
	)) as CheckoutFulfillmentState
	if (before.purchaseIds.length > 0) {
		return {
			status: 'already_fulfilled',
			checkoutSessionId,
			chargeId,
			purchaseIds: before.purchaseIds,
			state: before,
		}
	}

	const guardedDb: CheckoutFulfillDatabase = {
		...deps.db,
		createMerchantChargeAndPurchase: async (options) => {
			const current = await inspectNow()
			if (current.purchaseIds.length > 0) {
				throw await nonRetriable(
					new CheckoutAlreadyFulfilledError(current.purchaseIds),
				)
			}
			return deps.db.createMerchantChargeAndPurchase(options)
		},
	}

	let purchaseId: string
	try {
		const result = (await deps.handler({
			event: {
				name: 'stripe/checkout-session-completed',
				data: buildCheckoutCompletedEventData(session, deps.txnId),
			},
			step: deps.step,
			db: guardedDb,
			paymentProvider: deps.paymentProvider,
			notificationProvider: deps.notificationProvider,
		})) as { purchase?: { id?: string } } | undefined
		if (!result?.purchase?.id) {
			throw new Error('Checkout handler returned no purchase')
		}
		purchaseId = result.purchase.id
	} catch (error) {
		// A late original run can win between the re-check and the write. It
		// either trips the guard or makes the adapter fail on the unique charge
		// key. Either way, a purchase now exists and this path has nothing to do.
		const after = (await deps.step.run(
			'reconcile: re-check after handler error',
			inspectNow,
		)) as CheckoutFulfillmentState
		if (after.purchaseIds.length > 0) {
			return {
				status: 'raced',
				checkoutSessionId,
				chargeId,
				purchaseIds: after.purchaseIds,
				state: after,
			}
		}
		if (isAlreadyFulfilledError(error)) {
			throw new Error(
				'Guard reported a purchase that the re-check cannot find',
			)
		}
		throw error
	}

	const after = (await deps.step.run(
		'reconcile: verify one purchase',
		inspectNow,
	)) as CheckoutFulfillmentState
	if (!after.purchaseIds.includes(purchaseId) || after.purchaseIds.length !== 1) {
		throw new Error(
			`Expected exactly one purchase for ${checkoutSessionId}, found ${after.purchaseIds.length}`,
		)
	}
	return {
		status: 'fulfilled',
		checkoutSessionId,
		chargeId,
		purchaseId,
		state: after,
	}
}

function skipped(
	checkoutSessionId: string,
	chargeId: string | null,
	reason: Extract<
		DirectCheckoutFulfillmentResult,
		{ status: 'skipped' }
	>['reason'],
): DirectCheckoutFulfillmentResult {
	return { status: 'skipped', checkoutSessionId, chargeId, reason }
}

/**
 * Wraps the guard error so Inngest fails the step without retrying it. The
 * import is lazy, so the CLI shim and tests do not need the SDK loaded.
 */
async function nonRetriable(error: CheckoutAlreadyFulfilledError) {
	const { NonRetriableError } = await import('inngest')
	return new NonRetriableError(error.message, { cause: error })
}
