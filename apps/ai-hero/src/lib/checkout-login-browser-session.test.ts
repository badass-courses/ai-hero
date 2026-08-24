import { describe, expect, it } from 'vitest'

import {
	checkoutLoginBrowserCookieOptions,
	createCheckoutLoginBrowserSession,
	hashCheckoutLoginBrowserSession,
} from './checkout-login-browser-session'

describe('checkout login browser session', () => {
	it('creates opaque session values and stores only a stable hash', () => {
		const first = createCheckoutLoginBrowserSession()
		const second = createCheckoutLoginBrowserSession()

		expect(first).not.toBe(second)
		expect(first.length).toBeGreaterThanOrEqual(40)
		expect(hashCheckoutLoginBrowserSession(first)).toHaveLength(64)
		expect(hashCheckoutLoginBrowserSession(first)).toBe(
			hashCheckoutLoginBrowserSession(first),
		)
		expect(hashCheckoutLoginBrowserSession(first)).not.toBe(first)
	})

	it('uses an HttpOnly same-site cookie scoped to the application', () => {
		expect(checkoutLoginBrowserCookieOptions()).toMatchObject({
			httpOnly: true,
			secure: true,
			sameSite: 'lax',
			path: '/',
			maxAge: 15 * 60,
		})
	})
})
