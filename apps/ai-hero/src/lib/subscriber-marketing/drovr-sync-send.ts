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

/**
 * How long a synchronous send may hold drovr's request before it answers
 * 202 and finishes in the background. drovr's executor deadline is 15 s;
 * the default leaves room for transit. Bounded so a bad value cannot let
 * drovr's deadline fire again or make every send a background send.
 */
export const DEFAULT_DROVR_SEND_DEADLINE_MS = 10_000
const MIN_DROVR_SEND_DEADLINE_MS = 1_000
const MAX_DROVR_SEND_DEADLINE_MS = 12_000

export function drovrSendDeadlineMs(
	env: Readonly<Record<string, string | number | undefined>>,
): number {
	const parsed = Number(env.AIH_DROVR_SEND_DEADLINE_MS)
	if (!Number.isFinite(parsed) || parsed <= 0) {
		return DEFAULT_DROVR_SEND_DEADLINE_MS
	}
	return Math.min(
		MAX_DROVR_SEND_DEADLINE_MS,
		Math.max(MIN_DROVR_SEND_DEADLINE_MS, Math.trunc(parsed)),
	)
}

export type DrovrSendBudget = {
	/** Take one slot; not ok means wait retryAfterMs. */
	take(): Promise<{ ok: boolean; retryAfterMs: number }>
	/** Give a taken slot back when no Kit call happened. */
	refund(): Promise<void>
}

const WINDOW_MS = 60_000

/**
 * A fixed one-minute window on Redis, shared across instances: INCR per
 * window key, over the limit is refused (and un-counted), and a refund is
 * a DECR. Fixed rather than sliding so a slot can be given back.
 */
/** The three Redis commands the budget needs; Upstash's client satisfies it. */
export type BudgetStore = {
	incr(key: string): Promise<number>
	decr(key: string): Promise<number>
	expire(key: string, seconds: number): Promise<unknown>
}

export function drovrSendBudget(
	redis: BudgetStore,
	perMinute: number,
	now: () => number = Date.now,
): DrovrSendBudget {
	const keyFor = (at: number) =>
		`drovr:executor:send:${Math.floor(at / WINDOW_MS)}`
	let lastKey: string | undefined
	return {
		async take() {
			const at = now()
			const key = keyFor(at)
			lastKey = key
			const count = await redis.incr(key)
			if (count === 1) await redis.expire(key, 120)
			if (count <= perMinute) return { ok: true, retryAfterMs: 0 }
			await redis.decr(key)
			return {
				ok: false,
				retryAfterMs: Math.max(1_000, WINDOW_MS - (at % WINDOW_MS)),
			}
		},
		async refund() {
			if (lastKey) await redis.decr(lastKey)
		},
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
