import { describe, expect, it, vi } from 'vitest'

import {
	createMagicLinkCallbackPath,
	createMagicLinkGetHandler,
} from './magic-link-confirmation'

function magicLinkRequest(method = 'GET') {
	return new Request(
		'https://www.aihero.dev/api/auth/callback/postmark?callbackUrl=https%3A%2F%2Fwww.aihero.dev%2Fwelcome&token=one-time-token&email=learner%40example.com',
		{ method },
	)
}

describe('magic-link confirmation boundary', () => {
	it('keeps an email scanner GET away from Auth.js token verification', async () => {
		const authHandler = vi.fn(async () => new Response(null, { status: 204 }))
		const handler = createMagicLinkGetHandler(authHandler)

		const response = await handler(magicLinkRequest())
		const location = new URL(response.headers.get('location')!)

		expect(response.status).toBe(307)
		expect(location.pathname).toBe('/login/verify')
		expect(location.searchParams.get('token')).toBe('one-time-token')
		expect(location.searchParams.get('email')).toBe('learner@example.com')
		expect(location.searchParams.get('callbackUrl')).toBe(
			'https://www.aihero.dev/welcome',
		)
		expect(authHandler).not.toHaveBeenCalled()
	})

	it('answers a scanner HEAD without touching Auth.js', async () => {
		const authHandler = vi.fn(async () => new Response(null, { status: 500 }))
		const handler = createMagicLinkGetHandler(authHandler)

		const response = await handler(magicLinkRequest('HEAD'))

		expect(response.status).toBe(204)
		expect(authHandler).not.toHaveBeenCalled()
	})

	it('delegates unrelated Auth.js GET requests', async () => {
		const authResponse = new Response(null, { status: 204 })
		const authHandler = vi.fn(async () => authResponse)
		const handler = createMagicLinkGetHandler(authHandler)
		const request = new Request('https://www.aihero.dev/api/auth/session')

		await expect(handler(request)).resolves.toBe(authResponse)
		expect(authHandler).toHaveBeenCalledWith(request)
	})

	it('builds the confirmed POST target from the bounded query fields', () => {
		expect(
			createMagicLinkCallbackPath({
				callbackUrl: 'https://www.aihero.dev/welcome',
				token: 'one-time-token',
				email: 'learner@example.com',
				ignored: 'not-forwarded',
			}),
		).toBe(
			'/api/auth/callback/postmark?callbackUrl=https%3A%2F%2Fwww.aihero.dev%2Fwelcome&token=one-time-token&email=learner%40example.com',
		)
	})

	it('rejects a confirmation without the token or email', () => {
		expect(
			createMagicLinkCallbackPath({
				callbackUrl: 'https://www.aihero.dev/welcome',
				token: undefined,
				email: 'learner@example.com',
			}),
		).toBeNull()
	})
})
