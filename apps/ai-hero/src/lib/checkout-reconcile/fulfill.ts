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
 *      or its charge means there is nothing to do. A purchase of the same
 *      product the buyer got since the session opened, by any other path,
 *      means a human already acted: hold, do not sell it twice. A product
 *      whose duplicates are caught after payment (C5) is
 *      fulfilled instead: fulfillment never refuses a paid order there, and
 *      its post-payment check flags the duplicate for a refund.
 *   2. A guarded adapter: inside the handler's own write step, immediately
 *      before `createMerchantChargeAndPurchase`, the guard reads both again,
 *      with the handler's resolved user and product, and throws a
 *      non-retriable error if either found a purchase. The handler stops
 *      before it sends `new-purchase-created`.
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
	CHECKOUT_RECONCILE_BUYER_HAS_PRODUCT,
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
	/** Best-effort bookkeeping only, never a paid-order veto. */
	onPaidSession?: (session: Stripe.Checkout.Session) => Promise<void>
	getCheckoutSession: (
		checkoutSessionId: string,
	) => Promise<Stripe.Checkout.Session>
	inspect: (input: {
		checkoutSessionId: string
		chargeId: string | null
	}) => Promise<CheckoutFulfillmentState>
	/**
	 * Whether a buyer who already got this product since the session opened
	 * holds the session for a human. False for products whose post-payment
	 * duplicate check flags it instead. Default: hold every product.
	 */
	holdsWhenBuyerHasProduct?: (productId: string) => boolean
	/** Active purchases of the product the buyer got at or after `since`. */
	findBuyerProductPurchases: (input: {
		userId: string | null
		email: string | null
		productId: string
		since: Date
	}) => Promise<string[]>
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
			/** A human must decide: the buyer already has the product. */
			status: 'held'
			checkoutSessionId: string
			chargeId: string
			reason: 'buyer_already_has_product'
			purchaseIds: string[]
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

export class CheckoutBuyerHasProductError extends Error {
	constructor(readonly purchaseIds: string[]) {
		super(
			`${CHECKOUT_RECONCILE_BUYER_HAS_PRODUCT}: ${purchaseIds.join(',')}`,
		)
		this.name = 'CheckoutBuyerHasProductError'
	}
}

function isAlreadyFulfilledError(error: unknown) {
	return (
		error instanceof Error &&
		error.message.includes(CHECKOUT_RECONCILE_ALREADY_FULFILLED)
	)
}

/** The guard's purchase ids, read back from the error message. */
function buyerHasProductIds(error: unknown): string[] | null {
	if (!(error instanceof Error)) return null
	const marker = `${CHECKOUT_RECONCILE_BUYER_HAS_PRODUCT}: `
	const index = error.message.indexOf(marker)
	if (index < 0) return null
	return error.message
		.slice(index + marker.length)
		.split(',')
		.filter(Boolean)
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
	const onPaidSession = deps.onPaidSession
	if (session.payment_status === 'paid' && onPaidSession) {
		await deps.step.run('reconcile: record gift use', () => onPaidSession(session))
	}
	if (charge.refunded) {
		return skipped(checkoutSessionId, charge.chargeId, 'refunded')
	}
	if (charge.disputed) {
		return skipped(checkoutSessionId, charge.chargeId, 'disputed')
	}
	const chargeId = charge.chargeId
	const since = new Date(session.created * 1000)

	const inspectNow = () => deps.inspect({ checkoutSessionId, chargeId })
	const holds = (productId: string) =>
		deps.holdsWhenBuyerHasProduct?.(productId) ?? true
	const before = (await deps.step.run(
		'reconcile: re-check fulfillment',
		async () => {
			const state = await inspectNow()
			const productId = session.metadata?.productId
			const buyerPurchaseIds =
				state.purchaseIds.length === 0 && productId && holds(productId)
					? await deps.findBuyerProductPurchases({
							userId: session.metadata?.userId ?? null,
							email:
								session.customer_details?.email ??
								session.customer_email ??
								null,
							productId,
							since,
						})
					: []
			return { state, buyerPurchaseIds }
		},
	)) as { state: CheckoutFulfillmentState; buyerPurchaseIds: string[] }
	if (before.state.purchaseIds.length > 0) {
		return {
			status: 'already_fulfilled',
			checkoutSessionId,
			chargeId,
			purchaseIds: before.state.purchaseIds,
			state: before.state,
		}
	}
	if (before.buyerPurchaseIds.length > 0) {
		return held(checkoutSessionId, chargeId, before.buyerPurchaseIds)
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
			// The handler's own resolved buyer and product, so a buyer the
			// pre-check could not name by metadata or email is covered too.
			const buyerPurchaseIds =
				options?.productId && holds(options.productId)
				? await deps.findBuyerProductPurchases({
						userId: options.userId ?? null,
						email: null,
						productId: options.productId,
						since,
					})
				: []
			if (buyerPurchaseIds.length > 0) {
				throw await nonRetriable(
					new CheckoutBuyerHasProductError(buyerPurchaseIds),
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
		const buyerPurchaseIds = buyerHasProductIds(error)
		if (buyerPurchaseIds) {
			return held(checkoutSessionId, chargeId, buyerPurchaseIds)
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

function held(
	checkoutSessionId: string,
	chargeId: string,
	purchaseIds: string[],
): DirectCheckoutFulfillmentResult {
	return {
		status: 'held',
		checkoutSessionId,
		chargeId,
		reason: 'buyer_already_has_product',
		purchaseIds,
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
async function nonRetriable(
	error: CheckoutAlreadyFulfilledError | CheckoutBuyerHasProductError,
) {
	const { NonRetriableError } = await import('inngest')
	return new NonRetriableError(error.message, { cause: error })
}
