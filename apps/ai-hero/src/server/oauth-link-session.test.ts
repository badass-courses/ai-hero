import { describe, expect, it, vi } from 'vitest'

import { createAuthenticatedOAuthLinkSessionResolver } from './oauth-link-session'

function cookieStore(value: string) {
	return {
		delete: vi.fn(),
		get: vi.fn((name: string) =>
			name === 'authjs.session-token' ? { value } : undefined,
		),
	}
}

describe('OAuth link session resolver', () => {
	it('returns a fresh database session bound to the same user', async () => {
		const resolve = createAuthenticatedOAuthLinkSessionResolver({
			getCookieStore: () => cookieStore('fresh-token'),
			getSessionAndUser: vi.fn(async () => ({
				session: {
					userId: 'alice',
					expires: new Date('2026-08-09T12:10:00.000Z'),
				},
				user: { id: 'alice' },
			})),
			now: () => new Date('2026-08-09T12:00:00.000Z'),
		})

		await expect(resolve()).resolves.toEqual({
			userId: 'alice',
			sessionToken: 'fresh-token',
		})
	})

	it('rejects an expired database session', async () => {
		const resolve = createAuthenticatedOAuthLinkSessionResolver({
			getCookieStore: () => cookieStore('expired-token'),
			getSessionAndUser: vi.fn(async () => ({
				session: {
					userId: 'alice',
					expires: new Date('2026-08-09T11:59:59.000Z'),
				},
				user: { id: 'alice' },
			})),
			now: () => new Date('2026-08-09T12:00:00.000Z'),
		})

		await expect(resolve()).resolves.toBeNull()
	})
})
