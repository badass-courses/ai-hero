import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	readMode: vi.fn().mockResolvedValue('shadow'),
	cache: vi.fn((fn: () => Promise<unknown>) => fn),
}))
vi.mock('next/cache', () => ({ unstable_cache: mocks.cache }))
vi.mock('@/lib/subscribe-bot-mode.server', () => ({
	readSubscribeBotMode: mocks.readMode,
}))

import { GET } from './route'

describe('form mode endpoint', () => {
	it('caches the tiny discovery response for five seconds without exposing server config', async () => {
		expect(mocks.cache).toHaveBeenCalledWith(
			mocks.readMode,
			['subscribe-bot-client-mode-v1'],
			{ revalidate: 5 },
		)
		const response = await GET()
		expect(response.headers.get('cache-control')).toBe(
			'public, max-age=5, s-maxage=5',
		)
		expect(await response.json()).toEqual({ mode: 'shadow' })
	})
})
