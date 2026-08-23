import { describe, expect, it } from 'vitest'

import { buildSupportEmailHref, getErrorInfo, getSafeAuthReferer } from './page'

describe('auth error page copy', () => {
	it('gives magic-link verification failures a recovery action', () => {
		const info = getErrorInfo('Verification')

		expect(info.title).toBe('Login link expired')
		expect(info.message).toContain('Request a fresh login link')
		expect(info.actions).toContainEqual(
			expect.objectContaining({
				label: 'Get a new login link',
				href: '/login',
			}),
		)
	})

	it('reduces a same-origin OAuth referer to allowlisted metadata', () => {
		const referer = getSafeAuthReferer(
			'https://www.aihero.dev/api/auth/callback/github?code=secret-code&state=secret-state&callbackUrl=%2Fprofile&customer%40example.com=private',
			'https://www.aihero.dev',
		)

		expect(referer).toEqual({
			route: 'oauth-callback',
			provider: 'github',
			hasCode: true,
			hasState: true,
			hasCallbackUrl: true,
		})
		expect(JSON.stringify(referer)).not.toContain('secret')
		expect(JSON.stringify(referer)).not.toContain('customer@example.com')
	})

	it.each([
		'https://evil.example/api/auth/callback/github?code=secret',
		'https://www.aihero.dev/reset/private-token?code=secret',
		'https://www.aihero.dev/api/auth/callback/attacker?state=secret',
		'not a url customer@example.com',
	] as const)('rejects an untrusted referer: %s', (referer) => {
		expect(getSafeAuthReferer(referer, 'https://www.aihero.dev')).toBeNull()
	})

	it.each([
		[
			'Configuration',
			"We couldn't complete sign-in",
			'choose a different sign-in method',
		],
		[
			'AccessDenied',
			'Sign-in was not completed',
			'choose a different sign-in method',
		],
		[
			'OAuthCallbackError',
			"Sign-in couldn't be completed",
			'without completing sign-in',
		],
		[
			'OAuthProfileMissingEmail',
			'Email address required',
			'verified email address',
		],
	] as const)(
		'gives %s neutral customer-safe recovery copy',
		(error, title, message) => {
			const info = getErrorInfo(error)

			expect(info.title).toBe(title)
			expect(info.message.toLowerCase()).toContain(message)
			expect(info.actions).toContainEqual(
				expect.objectContaining({ label: 'Try again', href: '/login' }),
			)
		},
	)

	it('maps arbitrary error text to a fixed public code and safe mail subject', () => {
		const rawError = 'customer@example.com&body=Bearer private-token'
		const info = getErrorInfo(rawError)
		const href = buildSupportEmailHref('support@example.com', info.supportCode)
		const renderedData = JSON.stringify({ info, href })

		expect(info.publicCode).toBe('unknown')
		expect(info.supportCode).toBe('AH-AUTH-100')
		expect(href).toBe(
			'mailto:support%40example.com?subject=AI+Hero+sign-in+help+%28AH-AUTH-100%29',
		)
		expect(renderedData).not.toContain(rawError)
		expect(renderedData).not.toContain('private-token')
	})
})
