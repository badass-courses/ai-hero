import { RetryAfterError } from 'inngest'

import {
	DROVR_SEND_RETRIES,
	drovrRetryDelayMs,
	type DrovrOutboxCapture,
	type DrovrOutboxEntry,
} from './drovr-outbox'

/** The function context's attempt fields (Inngest counts them per step). */
export type DrovrSendAttempt = { attempt: number; maxAttempts?: number }

export type DrovrOutboxCaptureFn = (
	entries: readonly DrovrOutboxEntry[],
	reason: unknown,
) => Promise<DrovrOutboxCapture>

/** The step's last try: Inngest will not retry what this throws. */
export function isFinalDrovrSendAttempt({
	attempt,
	maxAttempts,
}: DrovrSendAttempt): boolean {
	return (
		attemptIndex(attempt) + 1 >=
		(typeof maxAttempts === 'number' && maxAttempts > 0
			? maxAttempts
			: DROVR_SEND_RETRIES + 1)
	)
}

/** A missing or malformed attempt counts as the first. */
const attemptIndex = (attempt: unknown) =>
	typeof attempt === 'number' && Number.isInteger(attempt) && attempt >= 0
		? attempt
		: 0

const isNonRetriable = (error: unknown) =>
	error instanceof Error && error.name === 'NonRetriableError'

const retryAfterMsOf = (error: unknown): number | undefined => {
	const value = (error as { retryAfterMs?: unknown } | null)?.retryAfterMs
	return typeof value === 'number' ? value : undefined
}

export const httpStatusOf = (error: unknown): number | undefined => {
	const value = (error as { httpStatus?: unknown } | null)?.httpStatus
	return typeof value === 'number' ? value : undefined
}

/**
 * One drovr send as a step body. A failure before the last attempt is
 * rethrown as RetryAfterError: drovr's Retry-After (capped) or the backoff
 * table's delay, whichever is longer, so a short Retry-After never spends
 * the retry budget early. On the last attempt the unsent entries go to the
 * outbox and the step returns `outboxed(count)`, so the run completes and
 * the replay delivers them. With no outbox (the table is not there yet, or
 * no target) the original error is rethrown: the previous behaviour.
 */
export async function sendOrOutbox<T>(args: {
	attempt: DrovrSendAttempt
	send: () => Promise<T>
	unsent: () => readonly DrovrOutboxEntry[]
	capture: DrovrOutboxCaptureFn
	outboxed: (count: number) => T
}): Promise<T> {
	try {
		return await args.send()
	} catch (error) {
		if (isNonRetriable(error)) throw error
		if (isFinalDrovrSendAttempt(args.attempt)) {
			const captured = await args.capture(args.unsent(), error)
			if (captured.status === 'outboxed') return args.outboxed(captured.count)
			throw error
		}
		throw new RetryAfterError(
			error instanceof Error ? error.message : String(error),
			drovrRetryDelayMs(
				attemptIndex(args.attempt.attempt),
				retryAfterMsOf(error),
			),
			{ cause: error },
		)
	}
}
