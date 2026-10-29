import { Effect } from 'effect'

import type { DrovrParityReceiptSink } from './email-course/parity-receipt'

export type {
	DrovrParityReceiptSink,
	DrovrParityTransitionReceipt,
} from './email-course/parity-receipt'

export type DrovrParityOptions = {
	readonly config?: {
		readonly ingestUrl?: string
		readonly apiKey?: string
	}
	readonly fetch?: typeof fetch
	readonly warn?: (event: string, data: Record<string, unknown>) => unknown
	readonly timeoutMs?: number
	readonly schedule?: (task: () => Promise<void>) => void
}

/**
 * Parity comparison is retired. Keep the sink interface inert until the
 * remaining parity surface is removed from both repositories.
 */
export function createDrovrParityReceiptSink(
	_options: DrovrParityOptions = {},
): DrovrParityReceiptSink {
	return { push: () => Effect.void }
}
