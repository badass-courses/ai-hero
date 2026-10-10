// The companion shared client helper owns buyPathId, timing and transport.
// After it lands, replace this factory with:
// export { createBuyPathLogger as createPurchaseWaitLogger } from '@/lib/buy-path/client'
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

// Same factory/emitter shape as createBuyPathLogger(checkoutSessionId).
// No independent logger, identity, timing or transport implementation.
export const createPurchaseWaitLogger: (
	checkoutSessionId: string,
) => PurchaseWaitLogger = () => () => undefined
