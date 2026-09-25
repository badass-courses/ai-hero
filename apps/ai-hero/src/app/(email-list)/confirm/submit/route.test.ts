import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const logs = vi.hoisted(() => ({
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
}))
vi.mock('@/env.mjs', () => ({
	env: { DROVR_API_BASE_URL: 'https://drovr.test' },
}))
vi.mock('@/server/logger', () => ({ log: logs }))
vi.mock('@/server/with-skill', () => ({
	withSkill: <Handler>(handler: Handler) => handler,
}))

import { POST } from './route'

const token = 'v1.eyJjIjoiYyJ9.c2lnbmF0dXJl'
let fetcher: ReturnType<
	typeof vi.fn<[string | URL | Request, RequestInit?], Promise<Response>>
>

const submit = (
	fields: Record<string, string>,
	headers: Record<string, string> = { origin: 'https://www.aihero.dev' },
) =>
	POST(
		new NextRequest('https://www.aihero.dev/confirm/submit', {
			method: 'POST',
			headers: {
				'content-type': 'application/x-www-form-urlencoded',
				...headers,
			},
			body: new URLSearchParams(fields).toString(),
		}),
	)

beforeEach(() => {
	vi.clearAllMocks()
	fetcher = vi.fn<[string | URL | Request, RequestInit?], Promise<Response>>(
		async () => Response.json({ status: 'confirmed' }),
	)
	vi.stubGlobal('fetch', fetcher)
})
afterEach(() => {
	vi.unstubAllGlobals()
})

describe('POST /confirm/submit: the only place a double opt-in is confirmed', () => {
	it('confirms through drovr and 303s to /confirm with the result', async () => {
		const response = await submit({ t: token, action: 'confirm' })

		expect(response.status).toBe(303)
		expect(response.headers.get('location')).toBe(
			`https://www.aihero.dev/confirm?t=${encodeURIComponent(token)}&result=confirmed`,
		)
		expect(fetcher).toHaveBeenCalledTimes(1)
		expect(String(fetcher.mock.calls[0]?.[0])).toBe(
			'https://drovr.test/confirm',
		)
		expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
			method: 'POST',
			body: JSON.stringify({ token }),
		})
	})

	it('asks for a new link on action=resend', async () => {
		fetcher.mockImplementation(async () =>
			Response.json({ status: 'requested' }, { status: 202 }),
		)
		const response = await submit({ t: token, action: 'resend' })

		expect(String(fetcher.mock.calls[0]?.[0])).toBe(
			'https://drovr.test/confirm/resend',
		)
		expect(response.headers.get('location')).toContain('result=resent')
	})

	it('carries an expired or suppressed answer back to the page', async () => {
		fetcher.mockImplementation(async () => new Response(null, { status: 410 }))
		expect((await submit({ t: token })).headers.get('location')).toContain(
			'result=expired',
		)
		fetcher.mockImplementation(async () => new Response(null, { status: 409 }))
		expect((await submit({ t: token })).headers.get('location')).toContain(
			'result=suppressed',
		)
	})

	it.each([
		['a cross-site Origin', { origin: 'https://evil.example' }],
		['an opaque Origin', { origin: 'null' }],
		['no Origin and no fetch metadata', {}],
		['no Origin and a cross-site fetch', { 'sec-fetch-site': 'cross-site' }],
	])('refuses %s with 403 and never reaches drovr', async (_, headers) => {
		const response = await submit({ t: token, action: 'confirm' }, headers)

		expect(response.status).toBe(403)
		expect(fetcher).not.toHaveBeenCalled()
		expect(JSON.stringify(logs.warn.mock.calls)).not.toContain(token)
	})

	it('accepts the apex origin and a same-origin fetch without Origin', async () => {
		expect(
			(await submit({ t: token }, { origin: 'https://aihero.dev' })).status,
		).toBe(303)
		expect(
			(await submit({ t: token }, { 'sec-fetch-site': 'same-origin' })).status,
		).toBe(303)
	})

	it('never logs the token', async () => {
		await submit({ t: token, action: 'confirm' })
		expect(JSON.stringify(logs.info.mock.calls)).not.toContain(token)
	})
})
