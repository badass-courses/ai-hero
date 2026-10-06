import { Data, Effect } from 'effect'
import { NonRetriableError } from 'inngest'

import type { NewsletterSendPause } from '@/lib/subscriber-marketing/drovr-evergreen-sender'

/** Local AI Hero/org-aihero shadow-newsletter transport binding: the cron's
 * newsletter read/write adapters use KIT_V4_API_KEY. This is NOT a live account
 * ID, credential-derived key, cross-account limiter, or credential-rotation proof.
 * The existing app Redis adapter supplies persistence; no new client is created.
 */
export const NEWSLETTER_PAUSE_KEY =
	'aih:org-aihero:drovr:shadow-newsletter:kit-v4:provider-pause:v1'
export const NEWSLETTER_PAUSE_FALLBACK_MS = 120_000
export const MAX_NEWSLETTER_PAUSE_MS = 86_400_000

export interface NewsletterPauseStore {
	eval(script: string, keys: string[], args: (string | number)[]): Promise<unknown>
}

export class NewsletterPauseStorageError extends Data.TaggedError(
	'NewsletterPauseStorageError',
)<{
	readonly operation: 'read' | 'write'
	readonly reason: 'unavailable' | 'invalid-ttl'
}> {}

export const READ_NEWSLETTER_PAUSE = "return redis.call('PTTL', KEYS[1])"
/** Atomic server-side max of remaining TTL and requested duration. SET+PX
 * creates the marker and its TTL together. No shorter update can shorten a
 * longer existing pause. A marker without expiry fails closed, never repairs.
 */
export const EXTEND_NEWSLETTER_PAUSE = `
local remaining = redis.call('PTTL', KEYS[1])
if remaining == -1 then return -1 end
local requested = tonumber(ARGV[1])
if remaining >= requested then return remaining end
redis.call('SET', KEYS[1], 'kit-429', 'PX', requested)
return requested
`

/** Valid Retry-After = positive integer seconds or parseable IMF-fixdate,
 * future and <=24 hours. Missing/malformed/negative/zero/past/excessive =>120s.
 * A zero/past header is never interpreted as an immediate-retry instruction.
 */
export function newsletterPauseDurationMs(
	retryAfter: string | undefined,
	nowMs: number,
): number {
	if (!Number.isFinite(nowMs)) return NEWSLETTER_PAUSE_FALLBACK_MS
	const raw = retryAfter?.trim() ?? ''
	let delay = NEWSLETTER_PAUSE_FALLBACK_MS
	if (/^\d+$/.test(raw)) {
		const seconds = Number(raw)
		if (Number.isSafeInteger(seconds)) delay = seconds * 1_000
	} else if (/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(raw)) {
		delay = Date.parse(raw) - nowMs
	}
	return Number.isSafeInteger(delay) && delay > 0 && delay <= MAX_NEWSLETTER_PAUSE_MS
		? delay
		: NEWSLETTER_PAUSE_FALLBACK_MS
}

/** State sketch: absent/expired -> sendable; active -> paused; 429 -> atomic
 * extend -> paused; storage failure -> terminal-for-this-invocation, no retry.
 * TTL bounds cross-run pause, not indefinite rest-of-run replay protection.
 */
export function createNewsletterProviderPause(options: {
	store: NewsletterPauseStore
	now?: () => number
}): NewsletterSendPause {
	const now = options.now ?? Date.now
	const ttl = (operation: 'read' | 'write', script: string, args: (string | number)[]) =>
		Effect.tryPromise({
			try: () => options.store.eval(script, [NEWSLETTER_PAUSE_KEY], args),
			// Do not serialize transport causes (URLs/tokens/bodies) into Inngest.
			catch: () => new NewsletterPauseStorageError({ operation, reason: 'unavailable' }),
		}).pipe(Effect.flatMap((value) =>
			typeof value === 'number' && Number.isSafeInteger(value) &&
			(operation === 'read' ? value === -2 || value >= 0 : value > 0)
				? Effect.succeed(value)
				: Effect.fail(new NewsletterPauseStorageError({ operation, reason: 'invalid-ttl' })),
		))
	const run = async (work: Effect.Effect<number, NewsletterPauseStorageError>) => {
		const result = await Effect.runPromise(Effect.either(work))
		if (result._tag === 'Left') {
			throw new NonRetriableError(
				`newsletter provider pause ${result.left.operation}: ${result.left.reason}`,
			)
		}
		return result.right
	}
	return {
		isPaused: async () => (await run(ttl('read', READ_NEWSLETTER_PAUSE, []))) > 0,
		pause: async (retryAfter) => {
			await run(ttl('write', EXTEND_NEWSLETTER_PAUSE, [newsletterPauseDurationMs(retryAfter, now())]))
		},
	}
}
