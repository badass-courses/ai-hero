import { describe, expect, it, vi } from 'vitest'

import { hashOAuthLinkSession } from '@/server/oauth-link-intent'

import {
	createOAuthAccountLinkRequest,
	createOAuthAccountSwitchLogin,
} from './oauth-link-action'
import type { ConnectableOAuthProvider } from './oauth-link-cookie'

const expiresAt = new Date('2026-08-09T12:10:00.000Z')

function createRequest({
	provider,
	account = null,
	allowed = true,
}: {
	provider: ConnectableOAuthProvider
	account?: { access_token?: string | null } | null
	allowed?: boolean
}) {
	const issueIntent = vi.fn(async () => ({
		rawToken: 'opaque-link-token',
		expiresAt,
	}))
	const clearIntentCookies = vi.fn()
	const writeIntentCookie = vi.fn()
	const isUserAllowed = vi.fn(async () => allowed)
	const request = createOAuthAccountLinkRequest({
		provider,
		getAuthenticatedSession: vi.fn(async () => ({
			userId: 'session-user',
			sessionToken: 'fresh-session-token',
		})),
		findAccount: vi.fn(async () => account),
		issueIntent,
		clearIntentCookies,
		writeIntentCookie,
		isUserAllowed,
	})
	return {
		clearIntentCookies,
		isUserAllowed,
		issueIntent,
		request,
		writeIntentCookie,
	}
}

describe('OAuth account switch login', () => {
	it('signs out once and returns to email login for Discord', async () => {
		const signOut = vi.fn(async () => {})
		const switchLogin = createOAuthAccountSwitchLogin({ signOut })

		await expect(switchLogin()).resolves.toBeUndefined()
		expect(switchLogin).toHaveLength(0)
		expect(signOut).toHaveBeenCalledOnce()
		expect(signOut).toHaveBeenCalledWith({
			redirectTo: '/login?callbackUrl=/discord',
		})
	})
})

describe('OAuth account link request', () => {
	it.each<ConnectableOAuthProvider>(['github', 'discord'])(
		'derives the %s target and binding from the authenticated server session',
		async (provider) => {
			const { clearIntentCookies, issueIntent, request, writeIntentCookie } =
				createRequest({ provider })

			await expect(request()).resolves.toEqual({ status: 'ready' })
			expect(clearIntentCookies).toHaveBeenCalledOnce()
			expect(issueIntent).toHaveBeenCalledWith({
				targetUserId: 'session-user',
				provider,
				sessionBinding: hashOAuthLinkSession('fresh-session-token'),
			})
			expect(writeIntentCookie).toHaveBeenCalledWith({
				rawToken: 'opaque-link-token',
				expiresAt,
			})
			expect(clearIntentCookies.mock.invocationCallOrder[0]).toBeLessThan(
				issueIntent.mock.invocationCallOrder[0]!,
			)
			expect(issueIntent.mock.invocationCallOrder[0]).toBeLessThan(
				writeIntentCookie.mock.invocationCallOrder[0]!,
			)
		},
	)

	it.each<ConnectableOAuthProvider>(['github', 'discord'])(
		'keeps the fixed %s provider when forged browser arguments are supplied',
		async (provider) => {
			const { issueIntent, request } = createRequest({ provider })

			await Reflect.apply(request, null, [
				provider === 'github' ? 'discord' : 'github',
				'victim-user',
			])

			expect(request).toHaveLength(0)
			expect(issueIntent).toHaveBeenCalledWith(
				expect.objectContaining({
					targetUserId: 'session-user',
					provider,
				}),
			)
		},
	)

	it('does not persist or write a cookie without a valid session', async () => {
		const issueIntent = vi.fn()
		const clearIntentCookies = vi.fn()
		const writeIntentCookie = vi.fn()
		const request = createOAuthAccountLinkRequest({
			provider: 'github',
			getAuthenticatedSession: vi.fn(async () => null),
			findAccount: vi.fn(),
			issueIntent,
			clearIntentCookies,
			writeIntentCookie,
			isUserAllowed: vi.fn(),
		})

		await expect(request()).resolves.toEqual({ status: 'unauthenticated' })
		expect(clearIntentCookies).not.toHaveBeenCalled()
		expect(issueIntent).not.toHaveBeenCalled()
		expect(writeIntentCookie).not.toHaveBeenCalled()
	})

	it('does not issue another intent for an already linked session', async () => {
		const { isUserAllowed, issueIntent, request } = createRequest({
			provider: 'github',
			account: { access_token: 'active-token' },
			allowed: false,
		})

		await expect(request()).resolves.toEqual({ status: 'linked' })
		expect(isUserAllowed).not.toHaveBeenCalled()
		expect(issueIntent).not.toHaveBeenCalled()
	})

	it('fails closed before issuing a GitHub intent outside rollout', async () => {
		const { isUserAllowed, issueIntent, request, writeIntentCookie } =
			createRequest({ provider: 'github', allowed: false })

		await expect(request()).resolves.toEqual({ status: 'rollout-denied' })
		expect(isUserAllowed).toHaveBeenCalledWith('session-user')
		expect(issueIntent).not.toHaveBeenCalled()
		expect(writeIntentCookie).not.toHaveBeenCalled()
	})

	it('issues a same-owner renewal intent when rollout allows it', async () => {
		const { issueIntent, request } = createRequest({
			provider: 'github',
			account: { access_token: null },
		})

		await expect(request()).resolves.toEqual({ status: 'ready' })
		expect(issueIntent).toHaveBeenCalledOnce()
	})
})
