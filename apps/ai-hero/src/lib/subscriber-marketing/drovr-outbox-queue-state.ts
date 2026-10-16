import { readHeldContinuationEnvelope } from './drovr-outbox-control'

/** Operational state comes ONLY from heldContinuation; lastError is opaque text. */
export function readOutboxQueueState(
	value: unknown,
	diagnostic: string | null = null,
): {
	handoffs: number
	diagnostic: string | null
	invalid: boolean
	publicationId?: string
	waitingForStop?: boolean
	heldBatch?: unknown
	heldBatchBlocked?: boolean
	heldBatchReason?: string
} {
	try {
		const state = readHeldContinuationEnvelope(value)
		return {
			handoffs: state?.replayProof?.handoffs ?? 0,
			diagnostic,
			invalid: false,
			...(state?.replayProof?.waitingForStop === true
				? { waitingForStop: true }
				: {}),
			...(state?.replayProof?.publicationId
				? { publicationId: state.replayProof.publicationId }
				: {}),
			...(state?.continuation
				? {
						...(state.continuation.encoded !== undefined
							? { heldBatch: state.continuation.encoded }
							: {}),
						heldBatchBlocked: state.continuation.blocked,
						...(state.continuation.reason !== undefined
							? { heldBatchReason: state.continuation.reason }
							: {}),
					}
				: {}),
		}
	} catch {
		return { handoffs: 0, diagnostic, invalid: true, heldBatchBlocked: true }
	}
}
