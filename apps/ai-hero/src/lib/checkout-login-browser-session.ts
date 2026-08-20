import { createHash, randomBytes } from 'node:crypto'

export const CHECKOUT_LOGIN_BROWSER_COOKIE =
	'__Host-aih_checkout_login_session'
export const CHECKOUT_LOGIN_BROWSER_SESSION_MAX_AGE_SECONDS = 15 * 60

export function createCheckoutLoginBrowserSession() {
	return randomBytes(32).toString('base64url')
}

export function hashCheckoutLoginBrowserSession(value: string) {
	return createHash('sha256')
		.update(`ai-hero:checkout-login-browser-session:v1:${value}`)
		.digest('hex')
}

export function checkoutLoginBrowserCookieOptions() {
	return {
		httpOnly: true,
		secure: true,
		sameSite: 'lax' as const,
		path: '/',
		maxAge: CHECKOUT_LOGIN_BROWSER_SESSION_MAX_AGE_SECONDS,
	}
}
