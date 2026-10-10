export const CHECKOUT_RECONCILE_FULFILL_EVENT =
	'aihero/checkout-reconcile.fulfill-requested' as const

export type CheckoutReconcileFulfillRequested = {
	name: typeof CHECKOUT_RECONCILE_FULFILL_EVENT
	data: {
		checkoutSessionId: string
		/** `checkout-reconcile:<session id>`, the fulfill function's idempotency key. */
		reconcileKey: string
	}
}
