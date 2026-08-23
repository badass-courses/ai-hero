import { describe, expect, it, vi } from 'vitest'

import {
	MAGIC_LINK_COOKIE_NAME,
	createMagicLinkConfirmHandler,
	createMagicLinkGetHandler,
	readMagicLinkCookie,
} from './magic-link-confirmation'

const secret = 'confirmation-cookie-secret'
const now = 1_787_465_000_000

function magicLinkRequest(method = 'GET') {
	return new Request(
		'https://www.aihero.dev/api/auth/callback/postmark?callbackUrl=https%3A%2F%2Fwww.aihero.dev%2Fwelcome&token=one-time-token&email=learner%40example.com',
		{ method },
	)
}

function cookieValue(response: Response) {
	const setCookie = response.headers.get('set-cookie')
	expect(setCookie).toBeTruthy()
	const pair = setCookie!.split(';', 1)[0]!
	const separator = pair.indexOf('=')
	expect(pair.slice(0, separator)).toBe(MAGIC_LINK_COOKIE_NAME)
	return decodeURIComponent(pair.slice(separator + 1))
}

describe('magic-link confirmation boundary', () => {
	it('moves a callback GET into a signed HttpOnly cookie and query-free URL', async () => {
		const authHandler = vi.fn(async () => new Response(null, { status: 204 }))
		const handler = createMagicLinkGetHandler(authHandler, { secret, now })

		const response = await handler(magicLinkRequest())
		const location = new URL(response.headers.get('location')!)
		const setCookie = response.headers.get('set-cookie')!

		expect(response.status).toBe(307)
		expect(response.headers.get('referrer-policy')).toBe('no-referrer')
		expect(response.headers.get('cache-control')).toBe('no-store')
		expect(location.pathname).toBe('/login/verify')
		expect(location.search).toBe('')
		expect(setCookie).toContain('Max-Age=300')
		expect(setCookie).toContain('Path=/')
		expect(setCookie).toContain('HttpOnly')
		expect(setCookie).toContain('Secure')
		expect(setCookie).toContain('SameSite=Lax')
		expect(setCookie).not.toContain('one-time-token')
		expect(setCookie).not.toContain('learner@example.com')
		const value = cookieValue(response)
		expect(readMagicLinkCookie(value, secret, now)).toEqual({
			callbackUrl: 'https://www.aihero.dev/welcome',
			email: 'learner@example.com',
			token: 'one-time-token',
		})
		const tampered = `${value[0] === 'A' ? 'B' : 'A'}${value.slice(1)}`
		expect(readMagicLinkCookie(tampered, secret, now)).toBeNull()
		expect(authHandler).not.toHaveBeenCalled()
	})

	it('answers a scanner HEAD without touching Auth.js or setting a cookie', async () => {
		const authHandler = vi.fn(async () => new Response(null, { status: 500 }))
		const handler = createMagicLinkGetHandler(authHandler, { secret, now })

		const response = await handler(magicLinkRequest('HEAD'))

		expect(response.status).toBe(204)
		expect(response.headers.has('set-cookie')).toBe(false)
		expect(authHandler).not.toHaveBeenCalled()
	})

	it('delegates unrelated Auth.js GET requests', async () => {
		const authResponse = new Response(null, { status: 204 })
		const authHandler = vi.fn(async () => authResponse)
		const handler = createMagicLinkGetHandler(authHandler, { secret, now })
		const request = new Request('https://www.aihero.dev/api/auth/session')

		await expect(handler(request)).resolves.toBe(authResponse)
		expect(authHandler).toHaveBeenCalledWith(request)
	})

	it('consumes the cookie once and forwards a server-side Auth.js POST', async () => {
		const getHandler = createMagicLinkGetHandler(vi.fn(), { secret, now })
		const initialResponse = await getHandler(magicLinkRequest())
		const value = cookieValue(initialResponse)
		const authHandler = vi.fn(async (_request: Request) =>
			Response.redirect('https://www.aihero.dev/welcome', 302),
		)
		const confirmHandler = createMagicLinkConfirmHandler(authHandler, {
			secret,
			now,
		})

		const response = await confirmHandler(
			new Request('https://www.aihero.dev/api/auth/magic-link/confirm', {
				method: 'POST',
				headers: { cookie: `${MAGIC_LINK_COOKIE_NAME}=${value}` },
			}),
		)
		const forwarded = authHandler.mock.calls[0]![0]

		expect(forwarded.method).toBe('POST')
		expect(new URL(forwarded.url).pathname).toBe(
			'/api/auth/callback/postmark',
		)
		expect(new URL(forwarded.url).searchParams.get('token')).toBe(
			'one-time-token',
		)
		expect(new URL(forwarded.url).searchParams.get('email')).toBe(
			'learner@example.com',
		)
		expect(response.status).toBe(302)
		expect(response.headers.get('set-cookie')).toContain('Max-Age=0')
	})

	it.each(['missing', 'expired'] as const)(
		'fails safe and clears a %s cookie',
		async (cookieState) => {
			const initialResponse = await createMagicLinkGetHandler(vi.fn(), {
				secret,
				now,
			})(magicLinkRequest())
			const authHandler = vi.fn(async () =>
				new Response(null, { status: 500 }),
			)
			const confirmHandler = createMagicLinkConfirmHandler(authHandler, {
				secret,
				now: now + 301_000,
			})
			const headers =
				cookieState === 'expired'
					? {
							cookie: `${MAGIC_LINK_COOKIE_NAME}=${cookieValue(initialResponse)}`,
						}
					: undefined

			const response = await confirmHandler(
				new Request('https://www.aihero.dev/api/auth/magic-link/confirm', {
					method: 'POST',
					headers,
				}),
			)

			expect(response.status).toBe(303)
			expect(new URL(response.headers.get('location')!).pathname).toBe(
				'/login/verify',
			)
			expect(response.headers.get('set-cookie')).toContain('Max-Age=0')
			expect(authHandler).not.toHaveBeenCalled()
		},
	)
})
