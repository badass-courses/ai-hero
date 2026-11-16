import { describe, expect, it, vi } from 'vitest'

vi.mock('@/server/redis-client', () => ({ redis: {} }))

import { recordLearnerAgentUsage, USAGE_TTL_SECONDS, usageKeys } from './usage'

function fakeStore(exec: () => Promise<unknown> = async () => []) {
	const calls: unknown[][] = []
	const pipe = {
		hincrby: (...args: unknown[]) => (calls.push(['hincrby', ...args]), pipe),
		expire: (...args: unknown[]) => (calls.push(['expire', ...args]), pipe),
		exec,
	}
	return { store: { pipeline: () => pipe } as never, calls }
}

describe('recordLearnerAgentUsage', () => {
	const now = new Date('2026-11-16T15:30:00Z')

	it('counts the call per learner and per tool, by UTC day, with a TTL', async () => {
		const { store, calls } = fakeStore()
		await recordLearnerAgentUsage(
			{ userId: 'user-1', capability: 'read_lesson' },
			{ store, now },
		)
		const keys = usageKeys(now)
		expect(keys.users).toBe('learner-agent:usage:2026-11-16')
		expect(calls).toEqual([
			['hincrby', keys.users, 'user-1', 1],
			['hincrby', keys.tools, 'read_lesson', 1],
			['expire', keys.users, USAGE_TTL_SECONDS],
			['expire', keys.tools, USAGE_TTL_SECONDS],
		])
	})

	it('counts anonymous calls under anon', async () => {
		const { store, calls } = fakeStore()
		await recordLearnerAgentUsage(
			{ userId: null, capability: 'search_course' },
			{ store, now },
		)
		expect(calls[0]).toEqual(['hincrby', usageKeys(now).users, 'anon', 1])
	})

	it('never throws when the store fails', async () => {
		const { store } = fakeStore(async () => {
			throw new Error('redis down')
		})
		await expect(
			recordLearnerAgentUsage(
				{ userId: 'user-1', capability: 'read_lesson' },
				{ store, now },
			),
		).resolves.toBeUndefined()
	})
})
