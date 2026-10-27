import type Stripe from 'stripe'

/**
 * Where a checkout with no purchase stands on payment. A bank transfer
 * completes checkout unpaid, so the thanks page must not wait on a purchase
 * that only lands when the money does, days later.
 */
export type DelayedPaymentState =
	| {
			kind: 'awaiting_payment'
			method: 'bank_transfer' | 'other'
			/** Stripe's hosted page with the account and reference to pay to. */
			instructionsUrl: string | null
	  }
	| { kind: 'payment_failed' }
	| { kind: 'not_delayed' }

export function delayedPaymentState(
	session: Pick<Stripe.Checkout.Session, 'status' | 'payment_status'> & {
		payment_intent: string | Stripe.PaymentIntent | null
	},
): DelayedPaymentState {
	if (session.status !== 'complete' || session.payment_status !== 'unpaid') {
		return { kind: 'not_delayed' }
	}
	const intent =
		session.payment_intent && typeof session.payment_intent !== 'string'
			? session.payment_intent
			: null
	if (
		intent?.status === 'canceled' ||
		intent?.status === 'requires_payment_method'
	) {
		return { kind: 'payment_failed' }
	}
	const bankTransfer =
		intent?.next_action?.type === 'display_bank_transfer_instructions'
			? intent.next_action.display_bank_transfer_instructions
			: null
	return {
		kind: 'awaiting_payment',
		method: bankTransfer ? 'bank_transfer' : 'other',
		instructionsUrl: bankTransfer?.hosted_instructions_url ?? null,
	}
}

export type DelayedPaymentCopy = {
	eyebrow: string
	title: string
	body: string[]
	instructionsLabel: string | null
}

/** Buyer-facing words for each state. Plain, no em dashes. */
export function delayedPaymentCopy(
	state: Exclude<DelayedPaymentState, { kind: 'not_delayed' }>,
): DelayedPaymentCopy {
	if (state.kind === 'payment_failed') {
		return {
			eyebrow: 'Payment not received',
			title: "Your payment didn't go through",
			body: [
				"We didn't receive the payment for this order, so we couldn't give you access.",
				"If you already sent it, or you'd like to try again, email us and we'll sort it out.",
			],
			instructionsLabel: null,
		}
	}
	if (state.method === 'bank_transfer') {
		return {
			eyebrow: 'Thanks for your order',
			title: "We're waiting for your bank transfer",
			body: [
				"As soon as it arrives, usually within 1 to 3 business days, we'll email you and give you access.",
				state.instructionsUrl
					? "Your transfer details are on Stripe. You don't need to pay again."
					: "Stripe sent you the transfer details. You don't need to pay again.",
			],
			instructionsLabel: state.instructionsUrl ? 'View transfer details' : null,
		}
	}
	return {
		eyebrow: 'Thanks for your order',
		title: 'Your payment is on its way',
		body: [
			"Your bank is still processing it. As soon as it clears, usually within a few business days, we'll email you and give you access.",
			"You don't need to pay again.",
		],
		instructionsLabel: null,
	}
}
