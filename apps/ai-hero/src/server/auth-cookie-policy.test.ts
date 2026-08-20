import { describe, expect, it, vi } from 'vitest'

import {
	createRuntimeAuthCookiePolicyResolver,
	resolveAuthCookiePolicy,
} from './auth-cookie-policy'

function request(url: string, forwardedProto?: string) {
	return new Request(url, {
		headers: forwardedProto
			? { 'x-forwarded-proto': forwardedProto }
			: undefined,
	})
}

describe('Auth cookie policy', () => {
	it.each([
		{
			name: 'HTTP local development',
			request: request('http://ai-hero.localhost/api/auth/session', 'http'),
			secure: false,
			sessionCookie: 'authjs.session-token',
			intentCookie: 'aih-oauth-link-intent',
		},
		{
			name: 'HTTPS local development',
			request: request('http://ai-hero.localhost/api/auth/session', 'https'),
			secure: true,
			sessionCookie: '__Secure-authjs.session-token',
			intentCookie: '__Host-aih-oauth-link-intent',
		},
	])(
		'uses one policy for Auth.js, session lookup, and intent cookies in $name',
		async ({ request, secure, sessionCookie, intentCookie }) => {
			const resolve = createRuntimeAuthCookiePolicyResolver({
				getHeaders: vi.fn(),
				getAuthUrl: () => null,
			})

			await expect(resolve(request)).resolves.toMatchObject({
				secure,
				authSessionCookieName: sessionCookie,
				oauthLinkIntentCookieName: intentCookie,
			})
		},
	)

	it('uses forwarded protocol for server actions without a request object', async () => {
		const resolve = createRuntimeAuthCookiePolicyResolver({
			getHeaders: async () => new Headers({ 'x-forwarded-proto': 'https' }),
			getAuthUrl: () => null,
		})

		await expect(resolve()).resolves.toMatchObject({
			secure: true,
			authSessionCookieName: '__Secure-authjs.session-token',
			oauthLinkIntentCookieName: '__Host-aih-oauth-link-intent',
		})
	})

	it('uses the configured Auth.js URL before proxy or request protocols', () => {
		expect(
			resolveAuthCookiePolicy({
				authUrl: 'http://localhost:3000',
				request: request('https://ai-hero.localhost/api/auth/session', 'https'),
			}),
		).toMatchObject({
			secure: false,
			authSessionCookieName: 'authjs.session-token',
			oauthLinkIntentCookieName: 'aih-oauth-link-intent',
		})
	})
})
