import { describe, expect, it, vi } from 'vitest'

import {
	clearOAuthLinkIntentCookies,
	createOAuthCookiePolicy,
	oauthLinkIntentCookieNames,
	readAuthSessionToken,
	readOAuthLinkIntentToken,
	writeOAuthLinkIntentCookie,
} from './oauth-link-cookie'

function cookieStore(values: Record<string, string> = {}) {
	return {
		delete: vi.fn(),
		get: vi.fn((name: string) => {
			const value = values[name]
			return typeof value === 'string' ? { value } : undefined
		}),
		set: vi.fn(),
	}
}

describe('OAuth cookie policy', () => {
	it.each([
		{
			secure: true,
			sessionName: '__Secure-authjs.session-token',
			intentName: '__Host-aih-oauth-link-intent',
		},
		{
			secure: false,
			sessionName: 'authjs.session-token',
			intentName: 'aih-oauth-link-intent',
		},
	])(
		'selects expected session and intent cookies for secure=$secure',
		({ secure, sessionName, intentName }) => {
			const policy = createOAuthCookiePolicy(secure)
			const store = cookieStore({
				[sessionName]: 'session-token',
				[intentName]: 'intent-token',
			})

			expect(readAuthSessionToken(store, policy)).toBe('session-token')
			expect(readOAuthLinkIntentToken(store, policy)).toBe('intent-token')
		},
	)

	it.each([
		{
			secure: true,
			values: {
				'aih-oauth-link-intent': 'stale-non-secure',
				'__Host-aih-oauth-link-intent': 'fresh-secure',
			},
		},
		{
			secure: false,
			values: {
				'aih-oauth-link-intent': 'fresh-non-secure',
				'__Host-aih-oauth-link-intent': 'stale-secure',
			},
		},
	])(
		'rejects conflicting intent cookie variants for secure=$secure',
		({ secure, values }) => {
			expect(() =>
				readOAuthLinkIntentToken(
					cookieStore(values),
					createOAuthCookiePolicy(secure),
				),
			).toThrow('intent cookie selection is ambiguous')
		},
	)

	it('never lets the non-secure intent cookie shadow the production cookie', () => {
		const store = cookieStore({
			'aih-oauth-link-intent': 'same-token',
			'__Host-aih-oauth-link-intent': 'same-token',
		})

		expect(
			readOAuthLinkIntentToken(store, createOAuthCookiePolicy(true)),
		).toBe('same-token')
		expect(store.get.mock.calls[0]).toEqual([
			'__Host-aih-oauth-link-intent',
		])
	})

	it.each([
		{ secure: true, name: '__Host-aih-oauth-link-intent' },
		{ secure: false, name: 'aih-oauth-link-intent' },
	])('writes only the expected intent cookie for secure=$secure', ({ secure, name }) => {
		const store = cookieStore()
		const expiresAt = new Date('2026-08-20T12:10:00.000Z')

		writeOAuthLinkIntentCookie(
			store,
			{ rawToken: 'opaque-token', expiresAt },
			createOAuthCookiePolicy(secure),
		)

		expect(store.set).toHaveBeenCalledWith(name, 'opaque-token', {
			httpOnly: true,
			secure,
			sameSite: 'lax',
			path: '/',
			expires: expiresAt,
		})
	})

	it('clears both intent cookie variants', () => {
		const store = cookieStore()
		clearOAuthLinkIntentCookies(store)
		expect(store.delete.mock.calls).toEqual(
			oauthLinkIntentCookieNames.map((name) => [name]),
		)
	})
})
