import { redis } from '@/server/redis-client'

/**
 * Per-learner daily call counts for the learner agent, so a retirement or any
 * other change knows who actually uses it, not only who once connected.
 *
 * Two Redis hashes per UTC day, kept 60 days:
 * - `learner-agent:usage:<day>`: userId (or `anon`) to calls
 * - `learner-agent:usage-tools:<day>`: tool name to calls
 *
 * Counting never blocks or fails a call.
 */
export const USAGE_TTL_SECONDS = 60 * 24 * 60 * 60

export const usageKeys = (now: Date) => {
	const day = now.toISOString().slice(0, 10)
	return {
		users: `learner-agent:usage:${day}`,
		tools: `learner-agent:usage-tools:${day}`,
	}
}

type UsageStore = Pick<typeof redis, 'pipeline'>

export async function recordLearnerAgentUsage(
	{ userId, capability }: { userId: string | null; capability: string },
	{ store = redis, now = new Date() }: { store?: UsageStore; now?: Date } = {},
): Promise<void> {
	const keys = usageKeys(now)
	try {
		const pipe = store.pipeline()
		pipe.hincrby(keys.users, userId ?? 'anon', 1)
		pipe.hincrby(keys.tools, capability, 1)
		pipe.expire(keys.users, USAGE_TTL_SECONDS)
		pipe.expire(keys.tools, USAGE_TTL_SECONDS)
		await pipe.exec()
	} catch {
		// Usage is a measurement; a lost count never costs the learner a call.
	}
}
