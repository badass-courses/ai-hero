// Mirrors `@coursebuilder/commerce/dispute-events`, which emits these from the
// Stripe webhook. Kept local until the app depends on a commerce release that
// exports them; the names and payloads are the contract.
export const PURCHASE_DISPUTE_OPENED_EVENT = 'commerce/purchase-dispute-opened'
export const PURCHASE_DISPUTE_CLOSED_EVENT = 'commerce/purchase-dispute-closed'

export type PurchaseDisputeOpened = {
	data: {
		stripeChargeId: string
		stripeDisputeId: string
		purchaseId: string
		previousStatus: string
	}
}

export type PurchaseDisputeClosed = {
	data: {
		stripeChargeId: string
		stripeDisputeId: string
		purchaseId: string
		previousStatus: string
		disputeStatus: string
		outcome: 'won' | 'lost'
	}
}
