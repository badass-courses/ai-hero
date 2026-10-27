import type { TransferDenialCode } from './transfer-lifecycle'

/**
 * What a transfer server action returns when the lifecycle refuses the
 * request. A denial is an expected outcome, not a fault: it travels back to
 * the client as data so Next does not turn it into a 500.
 */
export type TransferDenialResult = {
	ok: false
	code: TransferDenialCode
	message: string
}

export type InitiateTransferResult<T> = { ok: true; transfer: T } | TransferDenialResult

export function isTransferDenialResult(
	value: unknown,
): value is TransferDenialResult {
	return (
		typeof value === 'object' &&
		value !== null &&
		(value as { ok?: unknown }).ok === false &&
		typeof (value as { message?: unknown }).message === 'string'
	)
}
