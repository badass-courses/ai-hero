import { Ratelimit } from '@upstash/ratelimit'
import { env } from '@/env.mjs'
import { log } from '@/server/logger'
import { redis } from '@/server/redis-client'

/**
 * Budgets for the OAuth endpoints. Authorize, token and register are per
 * IP; the CIMD fetch is per client host, so one host cannot be made a
 * target through many sign-in attempts. Only the new authorization code
 * paths count: the device flow keeps no limit, as before.
 */
const BUDGETS = {
	authorize: 30,
	token: 30,
	register: 10,
	'cimd-host': 10,
} as const

export type OAuthLimit = keyof typeof BUDGETS

const limiters = Object.fromEntries(
	Object.entries(BUDGETS).map(([kind, budget]) => [
		kind,
		new Ratelimit({
			redis,
			prefix: `learner-oauth:${kind}`,
			limiter: Ratelimit.slidingWindow(budget, '1 m'),
		}),
	]),
) as Record<OAuthLimit, Ratelimit>

/** Development has no Redis: count in memory instead. */
const developmentCounts = new Map<string, { count: number; until: number }>()
function developmentLimit(key: string, budget: number) {
	const now = Date.now()
	for (const [k, v] of developmentCounts)
		if (v.until < now) developmentCounts.delete(k)
	const current = developmentCounts.get(key) ?? {
		count: 0,
		until: now + 60_000,
	}
	current.count++
	developmentCounts.set(key, current)
	return current.count <= budget
}

/** True when the call may go ahead. A limiter outage lets it through, loudly. */
export async function oauthRateLimit(
	kind: OAuthLimit,
	key: string,
): Promise<boolean> {
	try {
		const allowed =
			env.NODE_ENV === 'development'
				? developmentLimit(`${kind}:${key}`, BUDGETS[kind])
				: (await limiters[kind].limit(key)).success
		if (!allowed)
			void log.warn('learner_agent.oauth', {
				outcome: 'rate_limited',
				limit: kind,
			})
		return allowed
	} catch (error) {
		void log.error('learner_agent.oauth', {
			outcome: 'rate_limit_failed',
			limit: kind,
			error: error instanceof Error ? error.message : String(error),
		})
		return true
	}
}
