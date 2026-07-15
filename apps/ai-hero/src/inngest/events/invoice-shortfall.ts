export const INVOICE_SHORTFALL_RECONCILE_EVENT =
	'aihero/invoice-shortfall.reconcile' as const

export type InvoiceShortfallReconcile = {
	name: typeof INVOICE_SHORTFALL_RECONCILE_EVENT
	data: {
		customerId: string
		stripeEventId: string
		stripeEventType:
			| 'cash_balance.funds_available'
			| 'customer_cash_balance_transaction.created'
	}
}
