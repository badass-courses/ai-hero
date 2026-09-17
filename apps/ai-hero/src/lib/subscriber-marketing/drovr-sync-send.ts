import { Ratelimit } from '@upstash/ratelimit'
import type { Redis } from '@upstash/redis'

/**
 * The synchronous send (decision 2026-09-17): drovr posts an intent and the
 * executor sends inside the request, answering completed, blocked, or
 * retry with a wait. Behind a flag so the cron path is the rollback.
 *
 * Kit allows 120 requests per rolling minute per API key, shared by every
 * Kit call ai-hero makes. drovr gets a bounded share; over budget answers
 * retry without touching Kit, and Kit's own 429 becomes the same answer.
 */
export type DrovrSyncSendConfig =
	| { enabled: false; reason: string }
	| { enabled: true; perMinute: number }

export const DEFAULT_DROVR_SEND_BUDGET_PER_MINUTE = 60

export function parseDrovrSyncSendConfig(
	env: Readonly<Record<string, string | number | undefined>>,
): DrovrSyncSendConfig {
	const flag = String(env.AIH_DROVR_SYNC_SEND ?? '')
		.trim()
		.toLowerCase()
	if (flag !== 'true' && flag !== '1') {
		return { enabled: false, reason: 'AIH_DROVR_SYNC_SEND is not set' }
	}
	const parsed = Number(env.AIH_DROVR_SEND_BUDGET_PER_MINUTE)
	const perMinute =
		Number.isFinite(parsed) && parsed > 0
			? Math.trunc(parsed)
			: DEFAULT_DROVR_SEND_BUDGET_PER_MINUTE
	return { enabled: true, perMinute }
}

export type DrovrSendBudget = () => Promise<{
	ok: boolean
	retryAfterMs: number
}>

/** A sliding-window share of the Kit key for drovr's sends, across all instances. */
export function drovrSendBudget(
	redis: Redis,
	perMinute: number,
	now: () => number = Date.now,
): DrovrSendBudget {
	const limiter = new Ratelimit({
		redis,
		limiter: Ratelimit.slidingWindow(perMinute, '60 s'),
		prefix: 'drovr:executor:send',
	})
	return async () => {
		const decision = await limiter.limit('kit')
		return {
			ok: decision.success,
			retryAfterMs: decision.success
				? 0
				: Math.max(1_000, decision.reset - now()),
		}
	}
}

/** What drovr should wait after a retryable Kit failure. */
export const KIT_RATE_LIMIT_RETRY_MS = 60_000

export function retryAfterMsFor(
	nextRetryAt: string | undefined,
	now: string,
): number {
	if (nextRetryAt) {
		const wait = Date.parse(nextRetryAt) - Date.parse(now)
		if (Number.isFinite(wait) && wait > 0) return wait
	}
	return KIT_RATE_LIMIT_RETRY_MS
}
