import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	findFirst: vi.fn(),
	log: { error: vi.fn() },
}))
vi.mock('@/db', () => ({
	courseBuilderAdapter: {},
	db: { query: { contentResource: { findFirst: mocks.findFirst } } },
}))
vi.mock('@/server/auth', () => ({ getServerAuthSession: vi.fn() }))
vi.mock('@/server/logger', () => ({ log: mocks.log }))
vi.mock('next/cache', () => ({
	revalidateTag: vi.fn(),
	unstable_cache: (fn: unknown) => fn,
}))

import { getPage } from './pages-query'

describe('getPage', () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it('returns null without an error log when no row matches', async () => {
		mocks.findFirst.mockResolvedValue(undefined)

		await expect(getPage('missing-page')).resolves.toBeNull()
		expect(mocks.log.error).not.toHaveBeenCalled()
	})

	it('still logs page.parse.error for an existing malformed row', async () => {
		mocks.findFirst.mockResolvedValue({ id: 'page-1', type: 'page' })

		await expect(getPage('page-1')).resolves.toBeNull()
		expect(mocks.log.error).toHaveBeenCalledWith(
			'page.parse.error',
			expect.objectContaining({
				scope: 'page',
				slugOrId: 'page-1',
				error: expect.any(String),
			}),
		)
	})
})
