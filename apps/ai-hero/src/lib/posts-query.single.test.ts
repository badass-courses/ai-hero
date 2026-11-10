import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	findFirst: vi.fn(),
	getServerAuthSession: vi.fn(),
	log: { error: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
}))
vi.mock('@/db', () => ({
	courseBuilderAdapter: {},
	db: { query: { contentResource: { findFirst: mocks.findFirst } } },
}))
vi.mock('@/server/auth', () => ({
	getServerAuthSession: mocks.getServerAuthSession,
}))
vi.mock('@/server/logger', () => ({ log: mocks.log }))
vi.mock('@/inngest/inngest.server', () => ({ inngest: {} }))
vi.mock('@/lib/github-source-sync', () => ({
	syncPostFromGithubSource: vi.fn(),
}))
vi.mock('next/cache', () => ({
	revalidatePath: vi.fn(),
	revalidateTag: vi.fn(),
	unstable_cache: (fn: unknown) => fn,
}))
vi.mock('@upstash/redis', () => ({
	Redis: { fromEnv: () => ({ get: vi.fn(), set: vi.fn() }) },
}))
vi.mock('next/navigation', () => ({ redirect: vi.fn() }))
vi.mock('react', async (orig) => ({
	...(await orig<typeof import('react')>()),
	cache: (fn: unknown) => fn,
}))

import { getPost } from './posts-query'

describe('getPost', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.getServerAuthSession.mockResolvedValue({
			ability: { can: () => false },
		})
	})

	it('is null with a debug log and no error log when no row matches', async () => {
		mocks.findFirst.mockResolvedValue(undefined)

		await expect(getPost('missing-post')).resolves.toBeNull()
		expect(mocks.log.debug).toHaveBeenCalledWith('post.not_found', {
			slugOrId: 'missing-post',
		})
		expect(mocks.log.error).not.toHaveBeenCalled()
	})

	it('still logs post.parse.error for a malformed row', async () => {
		mocks.findFirst.mockResolvedValue({ id: 'post-1', type: 'post' })

		await expect(getPost('post-1')).resolves.toBeNull()
		expect(mocks.log.error).toHaveBeenCalledWith(
			'post.parse.error',
			expect.objectContaining({ scope: 'single' }),
		)
	})
})
