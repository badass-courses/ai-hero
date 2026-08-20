import { describe, expect, it, vi } from 'vitest'

import { createOAuthCookiePolicy } from '@/lib/oauth-link-cookie'

import { createAuthenticatedOAuthLinkSessionResolver } from './oauth-link-session'

function cookieStore(value: string) {
	return {
		delete: vi.fn(),
		get: vi.fn((name: string) =>
			name === 'authjs.session-token' ? { value } : undefined,
		),
	}
}

function conflictingCookieStore() {
	return {
		delete: vi.fn(),
		get: vi.fn((name: string) => {
			if (name === 'authjs.session-token') return { value: 'shadow-token' }
			if (name === '__Secure-authjs.session-token') {
				return { value: 'secure-token' }
			}
			return undefined
		}),
	}
}

describe('OAuth link session resolver', () => {
	it('returns a fresh database session bound to the same user', async () => {
		const resolve = createAuthenticatedOAuthLinkSessionResolver({
			getCookieStore: () => cookieStore('fresh-token'),
			getCookiePolicy: () => createOAuthCookiePolicy(false),
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

	it('rejects conflicting secure and non-secure session cookies', async () => {
		const getSessionAndUser = vi.fn()
		const resolve = createAuthenticatedOAuthLinkSessionResolver({
			getCookieStore: conflictingCookieStore,
			getCookiePolicy: () => createOAuthCookiePolicy(true),
			getSessionAndUser,
		})

		await expect(resolve()).rejects.toThrow('session cookie selection')
		expect(getSessionAndUser).not.toHaveBeenCalled()
	})

	it('rejects a non-secure cookie when Auth.js uses secure cookies', async () => {
		const getSessionAndUser = vi.fn()
		const resolve = createAuthenticatedOAuthLinkSessionResolver({
			getCookieStore: () => cookieStore('shadow-token'),
			getCookiePolicy: () => createOAuthCookiePolicy(true),
			getSessionAndUser,
		})

		await expect(resolve()).rejects.toThrow('session cookie selection')
		expect(getSessionAndUser).not.toHaveBeenCalled()
	})

	it('rejects an expired database session', async () => {
		const resolve = createAuthenticatedOAuthLinkSessionResolver({
			getCookieStore: () => cookieStore('expired-token'),
			getCookiePolicy: () => createOAuthCookiePolicy(false),
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
