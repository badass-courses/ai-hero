import { Ratelimit } from '@upstash/ratelimit'
import { env } from '@/env.mjs'
import { log } from '@/server/logger'
import { redis } from '@/server/redis-client'

import type { RateLimitPort } from '@ai-hero/learner-agent'

/**
 * Per-caller budgets on the learner surface. A signed-in learner gets 120
 * calls a minute, enough for an agent working a lesson, not enough to
 * crawl a paid course. Anonymous callers share an IP budget of 30.
 */
const learnerLimiter = new Ratelimit({
	redis,
	prefix: 'learner-agent:user',
	limiter: Ratelimit.slidingWindow(120, '1 m'),
})
const anonymousLimiter = new Ratelimit({
	redis,
	prefix: 'learner-agent:anon',
	limiter: Ratelimit.slidingWindow(30, '1 m'),
})

/** Development has no Redis: count in memory instead. */
const developmentCounts = new Map<string, { count: number; until: number }>()
function developmentLimit(key: string, limit: number) {
	const now = Date.now()
	for (const [k, v] of developmentCounts)
		if (v.until < now) developmentCounts.delete(k)
	const current = developmentCounts.get(key) ?? {
		count: 0,
		until: now + 60_000,
	}
	current.count++
	developmentCounts.set(key, current)
	return { success: current.count <= limit, reset: current.until }
}

export function requestIp(request: Request) {
	return (
		request.headers.get('x-real-ip') ??
		request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
		'unknown'
	)
}

export function makeRateLimitPort(request: Request): RateLimitPort {
	return {
		consume: async ({ userId, capability }) => {
			const key = userId ? `user:${userId}` : `ip:${requestIp(request)}`
			const limit = userId ? 120 : 30
			try {
				const verdict =
					env.NODE_ENV === 'development'
						? developmentLimit(key, limit)
						: await (userId ? learnerLimiter : anonymousLimiter).limit(key)
				if (verdict.success) return { ok: true }
				void log.warn('learner_agent.rate_limited', { userId, capability })
				return {
					ok: false,
					retryAfterSeconds: Math.max(
						1,
						Math.ceil((verdict.reset - Date.now()) / 1000),
					),
				}
			} catch (error) {
				// The limiter's own outage must not lock learners out; log it loudly.
				void log.error('learner_agent.rate_limit_failed', {
					capability,
					error: error instanceof Error ? error.message : String(error),
				})
				return { ok: true }
			}
		},
	}
}
