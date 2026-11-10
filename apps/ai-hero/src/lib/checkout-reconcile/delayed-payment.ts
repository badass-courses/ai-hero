/**
 * Delayed-payment checkouts: bank transfer (Stripe `customer_balance`) and
 * other methods where Stripe completes the session before the money lands.
 *
 * Stripe sends `checkout.session.completed` with `payment_status: unpaid`
 * when the buyer submits, then `checkout.session.async_payment_succeeded`
 * (or `..._failed`) once the bank settles, often days later. Course Builder
 * forwards the first to the core checkout handler, which cannot fulfill a
 * session with no charge, and only logs the second. This module:
 *
 *   1. guards the core handler, so an unpaid completion is recorded as
 *      awaiting payment instead of throwing and burning retries, and
 *   2. fulfills on `async_payment_succeeded` through the reconciler's direct
 *      path (`fulfillCheckoutSessionDirectly`), with its exactly-once guards.
 *
 * Upstream, `processStripeWebhook` in `@coursebuilder/commerce` should do
 * both itself; until then the app owns it.
 *
 * @module checkout-reconcile/delayed-payment
 */
import {
	fulfillCheckoutSessionDirectly,
	type DirectCheckoutFulfillmentDeps,
} from './fulfill'

type SessionPaymentFields = {
	mode?: string | null
	status?: string | null
	payment_status?: string | null
}

/**
 * True when checkout finished but the money has not arrived yet. Stripe will
 * follow with `async_payment_succeeded` or `async_payment_failed`.
 */
export function awaitsDelayedPayment(session: SessionPaymentFields): boolean {
	return (
		session.mode === 'payment' &&
		session.status === 'complete' &&
		session.payment_status === 'unpaid'
	)
}

export type AwaitingPaymentRecord = {
	checkoutSessionId: string
	productId: string | null
	amountTotal: number | null
}

export type AwaitingPaymentResult = AwaitingPaymentRecord & {
	status: 'awaiting_payment'
}

/**
 * Wraps the core `stripe-checkout-session-completed` handler. An unpaid
 * delayed-payment completion is recorded and returns; everything else runs
 * the handler unchanged. The later `async_payment_succeeded` fulfills it.
 */
export function guardUnpaidCheckoutCompletion<
	Handler extends (input: any) => unknown,
>(
	handler: Handler,
	record: (attrs: AwaitingPaymentRecord) => Promise<void>,
): Handler {
	const guarded = async (input: any) => {
		const session = input?.event?.data?.stripeEvent?.data?.object as
			| (SessionPaymentFields & {
					id: string
					amount_total?: number | null
					metadata?: Record<string, string> | null
			  })
			| undefined
		if (!session || !awaitsDelayedPayment(session)) return handler(input)
		const attrs: AwaitingPaymentRecord = {
			checkoutSessionId: session.id,
			productId: session.metadata?.productId ?? null,
			amountTotal: session.amount_total ?? null,
		}
		await input.step.run('record checkout awaiting delayed payment', () =>
			record(attrs),
		)
		return { status: 'awaiting_payment', ...attrs } satisfies AwaitingPaymentResult
	}
	return guarded as Handler
}

export type AsyncPaidCheckoutDeps = Omit<
	DirectCheckoutFulfillmentDeps,
	'minAgeMs' | 'windowMs'
>

/**
 * Fulfills a session Stripe just reported paid, through the same guarded
 * path as the reconciler. The reconciler's age gates do not apply: the event
 * is the evidence of payment, a transfer can land days after the session
 * opened, and the 5-minute grace exists for a normal run that never comes
 * here. Webhook redelivery and a later reconciler pass find the purchase and
 * return `already_fulfilled`.
 */
export function fulfillAsyncPaidCheckout(
	checkoutSessionId: string,
	deps: AsyncPaidCheckoutDeps,
) {
	return fulfillCheckoutSessionDirectly(checkoutSessionId, {
		...deps,
		minAgeMs: 0,
		windowMs: Number.POSITIVE_INFINITY,
	})
}
