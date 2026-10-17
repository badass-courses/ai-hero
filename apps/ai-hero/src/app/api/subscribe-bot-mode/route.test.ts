import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
	const entries = new Map<string, unknown>()
	return {
		entries,
		readMode: vi.fn(),
		// Model the Data Cache contract: only fulfilled reads can be cached.
		cache: vi.fn((fn: () => Promise<unknown>, keys: string[]) => async () => {
			const key = JSON.stringify(keys)
			if (entries.has(key)) return entries.get(key)
			const value = await fn()
			entries.set(key, value)
			return value
		}),
	}
})
vi.mock('next/cache', () => ({ unstable_cache: mocks.cache }))
vi.mock('@/lib/subscribe-bot-mode.server', () => ({
	readSubscribeBotModeStrict: mocks.readMode,
}))

import { GET } from './route'

describe('form enabled endpoint', () => {
	beforeEach(() => {
		mocks.entries.clear()
		mocks.readMode.mockReset().mockResolvedValue('shadow')
	})

	it.each(['shadow', 'enforce'])(
		'exposes only enabled for %s, with a five-second success cache',
		async (mode) => {
			mocks.readMode.mockResolvedValue(mode)
			expect(mocks.cache).toHaveBeenCalledWith(
				expect.any(Function),
				['subscribe-bot-client-enabled-v2'],
				{ revalidate: 5 },
			)
			const response = await GET()
			expect(response.headers.get('cache-control')).toBe(
				'public, max-age=5, s-maxage=5',
			)
			expect(await response.json()).toEqual({ enabled: true })
		},
	)

	it('can cache a genuine disabled read, not an error fallback', async () => {
		mocks.readMode.mockResolvedValue('off')
		expect(await (await GET()).json()).toEqual({ enabled: false })
		expect(await (await GET()).json()).toEqual({ enabled: false })
		expect(mocks.readMode).toHaveBeenCalledTimes(1)
	})

	it('never caches a read failure or exposes rollout mode on failure', async () => {
		mocks.readMode.mockRejectedValueOnce(new Error('synthetic outage'))
		const failure = await GET()
		expect(failure.status).toBe(503)
		expect(failure.headers.get('cache-control')).toBe('no-store')
		expect(await failure.json()).toEqual({})
		expect(mocks.entries.size).toBe(0)
		expect(await (await GET()).json()).toEqual({ enabled: true })
		expect(await (await GET()).json()).toEqual({ enabled: true })
		expect(mocks.readMode).toHaveBeenCalledTimes(2)
	})
})
