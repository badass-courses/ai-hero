import { ConvertKitApiError } from '@coursebuilder/core/providers/convertkit'

import { kitWriteRetrySchedule } from './kit-write-retry'

export const KIT_INLINE_RETRY_BUDGET_MS = 5_000

type RetryEvent = {
	operation: string
	attempt: number
	status: 429
	delayMs: number
	delaySource: string
}

export type KitRateLimitRetryDeps = {
	sleep?: (ms: number) => Promise<void>
	random?: () => number
	now?: () => number
	/** Share across the HTTP calls in a compound subscription. */
	budget?: { startedAt: number; waitedMs: number }
	onRetry: (event: RetryEvent) => Promise<unknown>
	onExhausted?: (event: {
		operation: string
		attempts: number
		status: 429
		reason: 'attempts-exhausted' | 'budget-exceeded'
	}) => Promise<unknown>
}

/** Repeat only the refused Kit call, within a five-second inline delay budget. */
export async function withKitRateLimitRetry<T>(
	operation: string,
	work: () => Promise<T>,
	deps: KitRateLimitRetryDeps,
): Promise<T> {
	const sleep =
		deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
	const now = deps.now ?? Date.now
	const budget = deps.budget ?? { startedAt: now(), waitedMs: 0 }
	for (let attempt = 1; ; attempt++) {
		try {
			return await work()
		} catch (error) {
			if (!(error instanceof ConvertKitApiError) || error.status !== 429)
				throw error
			const schedule = kitWriteRetrySchedule(error, deps)!
			const jitter = Math.round(
				Math.min(1, Math.max(0, (deps.random ?? Math.random)())) * 500,
			)
			const delayMs =
				(schedule.delaySource === 'retry-after'
					? schedule.delayMs
					: 1_000 * 2 ** (attempt - 1)) + jitter
			const elapsed = Math.max(budget.waitedMs, now() - budget.startedAt)
			if (attempt > 2 || elapsed + delayMs > KIT_INLINE_RETRY_BUDGET_MS) {
				await deps.onExhausted?.({
					operation,
					attempts: attempt,
					status: 429,
					reason: attempt > 2 ? 'attempts-exhausted' : 'budget-exceeded',
				})
				throw error
			}
			await deps.onRetry({
				operation,
				attempt: attempt + 1,
				status: 429,
				delayMs,
				delaySource:
					schedule.delaySource === 'retry-after'
						? 'retry-after'
						: 'inline-backoff',
			})
			await sleep(delayMs)
			budget.waitedMs += delayMs
		}
	}
}
