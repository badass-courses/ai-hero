import { RetryAfterError } from 'inngest'

import {
	DROVR_SEND_RETRIES,
	drovrRetryDelayMs,
	drovrRetryWindowMs,
	type DrovrOutboxCapture,
	type DrovrOutboxEntry,
} from './drovr-outbox'

/** The function context's attempt fields (Inngest counts them per step). */
export type DrovrSendAttempt = { attempt: number; maxAttempts?: number }

export type DrovrOutboxCaptureFn = (
	entries: readonly DrovrOutboxEntry[],
	reason: unknown,
	options?: { nextAttemptAt?: Date },
) => Promise<DrovrOutboxCapture>

/** Mark captured rows delivered if still pending (settleDrovrOutbox). */
export type DrovrOutboxSettleFn = (
	entries: readonly DrovrOutboxEntry[],
	note: string | null,
) => Promise<unknown>

/**
 * A step's stops, captured on their first failure (row 204b). The gate
 * reads only the outbox, so a stop still inside Inngest's retries would
 * not hold another run's later facts; captured at once, it does.
 */
export type DrovrStopsEarly<T = unknown> = {
	stops: () => readonly DrovrOutboxEntry[]
	settle: DrovrOutboxSettleFn
	/** What the settled rows record; by default "delivered by an Inngest retry". */
	noteFor?: (result: T) => string
}

export const DROVR_SETTLED_BY_RETRY = 'delivered by an Inngest retry'

/** The step's last try: Inngest will not retry what this throws. */
export function isFinalDrovrSendAttempt({
	attempt,
	maxAttempts,
}: DrovrSendAttempt): boolean {
	return attemptIndex(attempt) + 1 >= attemptsOf(maxAttempts)
}

const attemptsOf = (maxAttempts: unknown) =>
	typeof maxAttempts === 'number' && maxAttempts > 0
		? maxAttempts
		: DROVR_SEND_RETRIES + 1

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
 *
 * With `early`, the step's stops go to the outbox on their first failure
 * too (row 204b), so the stop gate sees them at once. Their rows wait out
 * the rest of Inngest's retry window (drovrRetryWindowMs) before the
 * replay may take them, so the replay and a retry don't both post one; if
 * Inngest runs later than its table and they do, drovr dedupes the second
 * post by its idempotency key. A retry that lands marks the rows delivered,
 * which opens the gate; the last attempt's capture finds them already
 * there (one row per dedupe key). A failed early capture is logged by the
 * capture and the step retries as before. The window uses this attempt's
 * Retry-After and the table after it, so later attempts' hints can stretch
 * Inngest's tail past it by up to their sum; any overlap is deduped.
 */
export async function sendOrOutbox<T>(args: {
	attempt: DrovrSendAttempt
	send: () => Promise<T>
	unsent: () => readonly DrovrOutboxEntry[]
	capture: DrovrOutboxCaptureFn
	outboxed: (count: number) => T
	early?: DrovrStopsEarly<T>
	now?: () => Date
}): Promise<T> {
	const now = args.now ?? (() => new Date())
	let result: T
	try {
		result = await args.send()
	} catch (error) {
		if (isNonRetriable(error)) throw error
		if (isFinalDrovrSendAttempt(args.attempt)) {
			const captured = await args.capture(args.unsent(), error)
			if (captured.status === 'outboxed') return args.outboxed(captured.count)
			throw error
		}
		const attempt = attemptIndex(args.attempt.attempt)
		const stops = args.early?.stops() ?? []
		if (stops.length > 0) {
			const window = drovrRetryWindowMs(
				attempt,
				attemptsOf(args.attempt.maxAttempts),
				retryAfterMsOf(error),
			)
			try {
				await args.capture(stops, error, {
					nextAttemptAt: new Date(now().getTime() + window),
				})
			} catch {
				// Logged with its keys by the capture; the retry goes on.
			}
		}
		throw new RetryAfterError(
			error instanceof Error ? error.message : String(error),
			drovrRetryDelayMs(attempt, retryAfterMsOf(error)),
			{ cause: error },
		)
	}
	// An earlier attempt failed and may have captured the stops.
	if (args.early && attemptIndex(args.attempt.attempt) > 0) {
		const stops = args.early.stops()
		if (stops.length > 0)
			await args.early.settle(
				stops,
				args.early.noteFor?.(result) ?? DROVR_SETTLED_BY_RETRY,
			)
	}
	return result
}
