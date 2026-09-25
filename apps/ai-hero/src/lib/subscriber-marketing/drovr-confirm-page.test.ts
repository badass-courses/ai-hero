import { describe, expect, it, vi } from 'vitest'

import {
	confirmPageView,
	readConfirmState,
	requestConfirmResend,
	submitConfirm,
	type ConfirmLookup,
} from './drovr-confirm-page'

const token = 'v1.eyJjIjoiYyJ9.c2lnbmF0dXJl'
const base = 'https://drovr.test'

const answering = (status: number, body?: unknown) => {
	const fetcher = vi.fn(
		async (_input: string | URL | Request, _init?: RequestInit) =>
			new Response(body === undefined ? null : JSON.stringify(body), {
				status,
			}),
	)
	return { fetcher, config: { baseUrl: base, fetch: fetcher } }
}

describe('readConfirmState (GET /confirm/state, a read)', () => {
	it('reads the state with a GET and nothing else', async () => {
		const { fetcher, config } = answering(200, {
			status: 'awaiting',
			formId: 'skills-newsletter',
			tenantId: 'org-aihero',
		})
		await expect(readConfirmState(token, config)).resolves.toEqual({
			status: 'ok',
			state: {
				status: 'awaiting',
				formId: 'skills-newsletter',
				tenantId: 'org-aihero',
			},
		})
		expect(fetcher).toHaveBeenCalledTimes(1)
		expect(String(fetcher.mock.calls[0]?.[0])).toBe(
			`${base}/confirm/state?t=${encodeURIComponent(token)}`,
		)
		expect(fetcher.mock.calls[0]?.[1]?.method).toBe('GET')
	})

	it.each([
		[400, { status: 'invalid-token' }],
		[404, { status: 'invalid-token' }],
		[503, { status: 'unavailable', reason: 'drovr-503' }],
	] as const)('maps %s', async (status, expected) => {
		await expect(
			readConfirmState(token, answering(status, {}).config),
		).resolves.toEqual(expected)
	})

	it('refuses an implausible token without a round trip, and an unreadable reply', async () => {
		const { fetcher, config } = answering(200, { nope: true })
		await expect(readConfirmState('not-a-token', config)).resolves.toEqual({
			status: 'invalid-token',
		})
		expect(fetcher).not.toHaveBeenCalled()
		await expect(readConfirmState(token, config)).resolves.toEqual({
			status: 'unavailable',
			reason: 'drovr-bad-reply',
		})
		await expect(
			readConfirmState(token, { baseUrl: undefined }),
		).resolves.toEqual({
			status: 'unavailable',
			reason: 'drovr-api-not-configured',
		})
	})
})

describe('submitConfirm (POST /confirm) and requestConfirmResend (POST /confirm/resend)', () => {
	it('posts the token as JSON and maps drovr answers', async () => {
		const { fetcher, config } = answering(200, { status: 'confirmed' })
		await expect(submitConfirm(token, config)).resolves.toBe('confirmed')
		expect(String(fetcher.mock.calls[0]?.[0])).toBe(`${base}/confirm`)
		expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
			method: 'POST',
			body: JSON.stringify({ token }),
		})

		for (const [status, body, outcome] of [
			[200, { status: 'already-confirmed' }, 'already-confirmed'],
			[410, {}, 'expired'],
			[409, {}, 'suppressed'],
			[400, {}, 'invalid-token'],
			[503, {}, 'unavailable'],
			[200, { status: 'maybe' }, 'unavailable'],
		] as const) {
			await expect(
				submitConfirm(token, answering(status, body).config),
			).resolves.toBe(outcome)
		}
	})

	it('asks for a new link and answers resent only on 202 requested', async () => {
		const { fetcher, config } = answering(202, { status: 'requested' })
		await expect(requestConfirmResend(token, config)).resolves.toBe('resent')
		expect(String(fetcher.mock.calls[0]?.[0])).toBe(`${base}/confirm/resend`)
		await expect(
			requestConfirmResend(token, answering(429, {}).config),
		).resolves.toBe('unavailable')
		await expect(
			requestConfirmResend(token, answering(400, {}).config),
		).resolves.toBe('invalid-token')
	})
})

describe('confirmPageView', () => {
	const ok = (status: 'awaiting' | 'confirmed' | 'expired' | 'suppressed') =>
		({
			status: 'ok',
			state: { status, formId: 'skills-newsletter', tenantId: 'org-aihero' },
		}) satisfies ConfirmLookup

	it('shows the button while awaiting, and the result only as words', () => {
		expect(confirmPageView(ok('awaiting'))).toEqual({ kind: 'awaiting' })
		expect(confirmPageView(ok('confirmed'), 'confirmed')).toEqual({
			kind: 'confirmed',
			justConfirmed: true,
		})
		expect(confirmPageView(ok('confirmed'))).toEqual({
			kind: 'confirmed',
			justConfirmed: false,
		})
		// A fetched `?result=confirmed` on a still-awaiting token shows the button.
		expect(confirmPageView(ok('awaiting'), 'confirmed')).toEqual({
			kind: 'awaiting',
		})
		expect(confirmPageView(ok('expired'))).toEqual({
			kind: 'expired',
			resent: false,
		})
		expect(confirmPageView(ok('expired'), 'resent')).toEqual({
			kind: 'expired',
			resent: true,
		})
		expect(confirmPageView(ok('suppressed'))).toEqual({ kind: 'suppressed' })
		expect(confirmPageView(ok('awaiting'), 'unavailable')).toEqual({
			kind: 'unavailable',
			canRetry: true,
		})
		expect(confirmPageView({ status: 'invalid-token' })).toEqual({
			kind: 'invalid',
		})
	})
})
