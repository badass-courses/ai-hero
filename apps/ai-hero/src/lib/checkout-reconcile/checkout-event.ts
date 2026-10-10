import type Stripe from 'stripe'

import type { StripeCheckoutSessionCompleted } from '@coursebuilder/core/events/stripe'
import { checkoutSessionCompletedEvent } from '@coursebuilder/core/schemas/stripe/checkout-session-completed'

function objectId(value: string | { id: string } | null): string | null {
	if (!value) return null
	return typeof value === 'string' ? value : value.id
}

/**
 * Rebuilds the `stripe/checkout-session-completed` event data from a
 * retrieved Checkout Session, in the shape the webhook would have sent.
 *
 * The core handler re-reads the session from Stripe in its own first steps,
 * so only the id, customer and payment intent here steer fulfillment. The
 * rest satisfies the event schema.
 */
export function buildCheckoutCompletedEventData(
	session: Stripe.Checkout.Session,
	txnId: string,
): StripeCheckoutSessionCompleted['data'] {
	const customerId = objectId(session.customer)
	const paymentIntentId = objectId(session.payment_intent)
	if (!customerId || !paymentIntentId || !session.customer_details) {
		throw new Error('Checkout session lacks customer or payment intent evidence')
	}

	const stripeEvent = checkoutSessionCompletedEvent.parse({
		id: `evt_${txnId}`,
		created: session.created,
		type: 'checkout.session.completed',
		data: {
			object: {
				...session,
				amount_subtotal: session.amount_subtotal ?? session.amount_total ?? 0,
				amount_total: session.amount_total ?? 0,
				custom_fields: session.custom_fields ?? [],
				customer: customerId,
				customer_details: session.customer_details,
				metadata: session.metadata ?? {},
				payment_intent: paymentIntentId,
				payment_method_collection:
					session.payment_method_collection ?? 'always',
				phone_number_collection:
					session.phone_number_collection ?? { enabled: false },
				subscription: null,
				success_url: session.success_url ?? '',
				total_details: session.total_details ?? {
					amount_discount: 0,
					amount_shipping: 0,
					amount_tax: 0,
				},
			},
		},
	})

	return { txnId, stripeEvent }
}
