import { NextRequest } from 'next/server'
import { describe, expect, it } from 'vitest'

import { GET } from './route'

describe('checkout login browser session route', () => {
	it('sets an HttpOnly browser binding and returns to verify-login', async () => {
		const returnTo =
			'/subscribe/verify-login?productId=product-crash-course&country=TR'
		const response = await GET(
			new NextRequest(
				`https://www.aihero.dev/subscribe/verify-login/browser-session?returnTo=${encodeURIComponent(returnTo)}`,
			),
		)

		expect(response.status).toBe(307)
		expect(response.headers.get('location')).toBe(
			`https://www.aihero.dev${returnTo}`,
		)
		const cookie = response.headers.get('set-cookie')
		expect(cookie).toContain('__Host-aih_checkout_login_session=')
		expect(cookie).toContain('HttpOnly')
		expect(cookie).toContain('Secure')
		expect(cookie).toContain('SameSite=lax')
		expect(cookie).toContain('Path=/')
	})

	it.each([
		undefined,
		'https://evil.example/subscribe/verify-login?productId=forged',
		'//evil.example/subscribe/verify-login?productId=forged',
		'/other-path?productId=forged',
	])('rejects an unsafe return target', async (returnTo) => {
		const url = new URL(
			'https://www.aihero.dev/subscribe/verify-login/browser-session',
		)
		if (returnTo) url.searchParams.set('returnTo', returnTo)

		const response = await GET(new NextRequest(url))

		expect(response.headers.get('location')).toBe(
			'https://www.aihero.dev/subscribe/error',
		)
	})
})
