import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	lookup: vi.fn(),
	notFound: vi.fn(() => { throw new Error('NEXT_HTTP_ERROR_FALLBACK;404') }),
}))
vi.mock('next/navigation', () => ({ notFound: mocks.notFound }))
vi.mock('@/lib/posts-query', () => ({ getCachedPostOrList: mocks.lookup }))

import { getRoutePost } from './get-route-post'

describe('getRoutePost', () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it.each(['index.php', 'wp-login.php', '.env', 'INDEX.PHP', 'config.json.bak'])(
		'sends %s to not-found before looking up content', async (slug) => {
			await expect(getRoutePost(slug)).rejects.toThrow('NEXT_HTTP_ERROR_FALLBACK;404')
			expect(mocks.notFound).toHaveBeenCalledOnce()
			expect(mocks.lookup).not.toHaveBeenCalled()
		},
	)

	it.each(['build-first-agent', 'post_123', 'a-post~abc12', '技能介绍', 'version-2.0'])(
		'preserves the lookup result for %s', async (slug) => {
			const post = { id: 'post-1', type: 'post' }
			mocks.lookup.mockResolvedValue(post)
			await expect(getRoutePost(slug)).resolves.toBe(post)
			expect(mocks.lookup).toHaveBeenCalledWith(slug)
			expect(mocks.notFound).not.toHaveBeenCalled()
		},
	)

	it('preserves null for an ordinary unknown slug', async () => {
		mocks.lookup.mockResolvedValue(null)
		await expect(getRoutePost('missing-post')).resolves.toBeNull()
		expect(mocks.notFound).not.toHaveBeenCalled()
	})

	it('does not hide genuine lookup failures', async () => {
		mocks.lookup.mockRejectedValue(new Error('database unavailable'))
		await expect(getRoutePost('valid-post')).rejects.toThrow('database unavailable')
		expect(mocks.notFound).not.toHaveBeenCalled()
	})
})
