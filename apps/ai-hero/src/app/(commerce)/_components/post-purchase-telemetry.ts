// The shared helper owns correlation, timing, validation and transport.
export { createBuyPathLogger as createPurchaseWaitLogger } from '@/lib/buy-path/client'
export type PurchaseWaitStep =
	| 'client_returned'
	| 'client_polling'
	| 'purchase_visible'
	| 'destination_rendered'

export type PurchaseWaitLogger = (
	step: PurchaseWaitStep,
	options?: {
		attempt?: number
		durationMs?: number
		outcome?: 'ok' | 'failed' | 'skipped'
	},
) => void
