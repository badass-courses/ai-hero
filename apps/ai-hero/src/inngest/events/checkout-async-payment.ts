export const CHECKOUT_ASYNC_PAYMENT_SUCCEEDED_EVENT =
	'aihero/checkout.async-payment-succeeded' as const

export type CheckoutAsyncPaymentSucceeded = {
	name: typeof CHECKOUT_ASYNC_PAYMENT_SUCCEEDED_EVENT
	data: {
		checkoutSessionId: string
		/** The Stripe event id, also the Inngest event id, so redelivery dedupes. */
		stripeEventId: string
	}
}
