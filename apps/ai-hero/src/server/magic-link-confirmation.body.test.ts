import { describe, expect, it, vi } from 'vitest'

import {
	MAGIC_LINK_COOKIE_NAME,
	createMagicLinkConfirmHandler,
	createMagicLinkGetHandler,
} from './magic-link-confirmation'

const secret = 'confirmation-cookie-secret'
const now = 1_787_465_000_000
const siteUrl = 'https://www.aihero.dev'
const confirmUrl = `${siteUrl}/api/auth/magic-link/confirm`

function authHandler() {
	return vi.fn(async (_request: Request) =>
		Response.redirect(`${siteUrl}/welcome`, 302),
	)
}

function post(
	fields: Record<string, string>,
	{ origin = siteUrl as string | null, json = false } = {},
) {
	const headers: Record<string, string> = {
		'content-type': json
			? 'application/json'
			: 'application/x-www-form-urlencoded',
	}
	if (origin) headers.origin = origin
	return new Request(confirmUrl, {
		method: 'POST',
		headers,
		body: json ? JSON.stringify(fields) : new URLSearchParams(fields),
	})
}

const valid = {
	token: 'one-time-token',
	email: 'learner@example.com',
	callbackUrl: `${siteUrl}/welcome?x=1`,
}

describe('magic-link confirm with body fields', () => {
	it.each([false, true])(
		'signs in through the same Auth.js callback as the cookie flow (json=%s)',
		async (json) => {
			const auth = authHandler()
			const handler = createMagicLinkConfirmHandler(auth, {
				secret,
				now,
				siteUrl,
			})

			const response = await handler(post(valid, { json }))
			const forwarded = auth.mock.calls[0]![0]
			const url = new URL(forwarded.url)

			expect(forwarded.method).toBe('POST')
			expect(url.pathname).toBe('/api/auth/callback/postmark')
			expect(url.searchParams.get('token')).toBe('one-time-token')
			expect(url.searchParams.get('email')).toBe('learner@example.com')
			expect(url.searchParams.get('callbackUrl')).toBe('/welcome?x=1')
			expect(response.status).toBe(302)
			expect(response.headers.get('set-cookie')).toContain('Max-Age=0')
		},
	)

	it('turns a foreign callbackUrl into the home page', async () => {
		const auth = authHandler()
		const handler = createMagicLinkConfirmHandler(auth, {
			secret,
			now,
			siteUrl,
		})

		await handler(post({ ...valid, callbackUrl: 'https://evil.example/x' }))

		expect(
			new URL(auth.mock.calls[0]![0].url).searchParams.get('callbackUrl'),
		).toBe('/')
	})

	it('prefers the body over a stale cookie', async () => {
		const auth = authHandler()
		const cookie = await createMagicLinkGetHandler(vi.fn(), { secret, now })(
			new Request(
				`${siteUrl}/api/auth/callback/postmark?token=old-token&email=old%40example.com`,
			),
		)
		const pair = cookie.headers.get('set-cookie')!.split(';', 1)[0]!
		const request = post(valid)
		request.headers.set('cookie', pair)
		const handler = createMagicLinkConfirmHandler(auth, {
			secret,
			now,
			siteUrl,
		})

		await handler(request)

		expect(new URL(auth.mock.calls[0]![0].url).searchParams.get('token')).toBe(
			'one-time-token',
		)
	})

	it.each([
		['cross-origin', { origin: 'https://evil.example' }],
		['originless', { origin: null }],
	] as const)('rejects a %s POST', async (_name, opts) => {
		const auth = authHandler()
		const handler = createMagicLinkConfirmHandler(auth, {
			secret,
			now,
			siteUrl,
		})

		const response = await handler(post(valid, opts))

		expect(response.status).toBe(403)
		expect(auth).not.toHaveBeenCalled()
	})

	it.each([
		['empty email', { ...valid, email: '' }],
		['oversized token', { ...valid, token: 'a'.repeat(2049) }],
		['oversized email', { ...valid, email: `${'a'.repeat(320)}@x.co` }],
		[
			'oversized callbackUrl',
			{ ...valid, callbackUrl: `/${'a'.repeat(2048)}` },
		],
	])('rejects %s', async (_name, fields) => {
		const auth = authHandler()
		const handler = createMagicLinkConfirmHandler(auth, {
			secret,
			now,
			siteUrl,
		})

		for (const json of [false, true]) {
			const response = await handler(post(fields, { json }))
			expect(response.status).toBe(400)
		}
		expect(auth).not.toHaveBeenCalled()
	})

	it('rejects non-string JSON fields, bad JSON and oversized bodies', async () => {
		const auth = authHandler()
		const handler = createMagicLinkConfirmHandler(auth, {
			secret,
			now,
			siteUrl,
		})
		const headers = { 'content-type': 'application/json', origin: siteUrl }

		const wrongType = await handler(
			new Request(confirmUrl, {
				method: 'POST',
				headers,
				body: JSON.stringify({ token: 1, email: ['x'], callbackUrl: null }),
			}),
		)
		const badJson = await handler(
			new Request(confirmUrl, { method: 'POST', headers, body: '{' }),
		)
		const huge = await handler(
			new Request(confirmUrl, {
				method: 'POST',
				headers,
				body: JSON.stringify({ ...valid, token: 'a'.repeat(9000) }),
			}),
		)

		expect([wrongType.status, badJson.status, huge.status]).toEqual([
			400, 400, 400,
		])
		expect(auth).not.toHaveBeenCalled()
	})

	it('treats a token-less form POST as the legacy cookie flow', async () => {
		const auth = authHandler()
		const handler = createMagicLinkConfirmHandler(auth, {
			secret,
			now,
			siteUrl,
		})

		const response = await handler(
			new Request(confirmUrl, {
				method: 'POST',
				headers: { 'content-type': 'application/x-www-form-urlencoded' },
				body: '',
			}),
		)

		expect(response.status).toBe(303)
		expect(response.headers.get('location')).toBe('/login/verify')
		expect(response.headers.get('set-cookie')).toContain(
			`${MAGIC_LINK_COOKIE_NAME}=`,
		)
		expect(auth).not.toHaveBeenCalled()
	})
})
