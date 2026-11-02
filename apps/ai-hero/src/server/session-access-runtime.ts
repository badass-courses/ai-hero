import { log } from '@/server/logger'
import {
	createSessionAccessCache,
	parseSessionAccessCacheTtl,
	SESSION_ACCESS_CACHE_TTL_ENV,
	type SessionAccessCacheEvent,
	type SessionAccessCacheStore,
} from '@/server/session-access-cache'

// One warning per event per minute: a Redis outage must not flood the logs.
const LOG_INTERVAL_MS = 60_000
const lastLoggedAt = new Map<SessionAccessCacheEvent, number>()

function logCacheEvent(event: SessionAccessCacheEvent, error?: unknown) {
	const now = Date.now()
	if (now - (lastLoggedAt.get(event) ?? 0) < LOG_INTERVAL_MS) return
	lastLoggedAt.set(event, now)
	void log.warn('auth.session-access-cache', {
		event,
		error: error instanceof Error ? error.message : undefined,
	})
}

/** The app's session access cache, backed by the existing Upstash Redis. */
export const sessionAccessCache = createSessionAccessCache({
	getStore: async () => {
		if (!(process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL))
			return null
		const { redis } = await import('@/server/redis-client')
		return redis as unknown as SessionAccessCacheStore
	},
	ttlSeconds: parseSessionAccessCacheTtl(
		process.env[SESSION_ACCESS_CACHE_TTL_ENV],
	),
	onEvent: logCacheEvent,
})

/** Call after any write to a user's roles or organization memberships. */
export function bustSessionAccessForUser(userId: string) {
	return sessionAccessCache.bustUser(userId)
}
