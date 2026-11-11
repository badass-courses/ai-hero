import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import { verifyMuxSignature } from './mux-webhook-signature'

const secret = 'test-signing-secret'
const rawBody = JSON.stringify({
	type: 'video.asset.ready',
	object: { id: 'a1' },
})
const nowMs = 1_794_434_000_000
const t = Math.floor(nowMs / 1000)
const sign = (ts: number, body = rawBody, key = secret) =>
	createHmac('sha256', key).update(`${ts}.${body}`).digest('hex')

describe('verifyMuxSignature', () => {
	it('accepts a correctly signed, fresh payload', () => {
		expect(
			verifyMuxSignature({
				rawBody,
				header: `t=${t},v1=${sign(t)}`,
				secret,
				nowMs,
			}),
		).toEqual({ ok: true })
	})

	it('accepts when any v1 signature matches', () => {
		expect(
			verifyMuxSignature({
				rawBody,
				header: `t=${t},v1=${'0'.repeat(64)},v1=${sign(t)}`,
				secret,
				nowMs,
			}),
		).toEqual({ ok: true })
	})

	it('refuses an unsigned request', () => {
		expect(
			verifyMuxSignature({ rawBody, header: null, secret, nowMs }),
		).toEqual({
			ok: false,
			reason: 'missing-header',
		})
	})

	it('refuses when no secret is configured', () => {
		expect(
			verifyMuxSignature({
				rawBody,
				header: `t=${t},v1=${sign(t)}`,
				secret: undefined,
				nowMs,
			}),
		).toEqual({ ok: false, reason: 'missing-secret' })
	})

	it('refuses a tampered body', () => {
		expect(
			verifyMuxSignature({
				rawBody: rawBody + ' ',
				header: `t=${t},v1=${sign(t)}`,
				secret,
				nowMs,
			}),
		).toEqual({ ok: false, reason: 'bad-signature' })
	})

	it('refuses a signature made with another secret', () => {
		expect(
			verifyMuxSignature({
				rawBody,
				header: `t=${t},v1=${sign(t, rawBody, 'other')}`,
				secret,
				nowMs,
			}),
		).toEqual({ ok: false, reason: 'bad-signature' })
	})

	it('refuses a replay outside the tolerance window', () => {
		const old = t - 301
		expect(
			verifyMuxSignature({
				rawBody,
				header: `t=${old},v1=${sign(old)}`,
				secret,
				nowMs,
			}),
		).toEqual({ ok: false, reason: 'stale-timestamp' })
	})

	it('refuses a malformed header', () => {
		expect(
			verifyMuxSignature({ rawBody, header: 'garbage', secret, nowMs }),
		).toEqual({
			ok: false,
			reason: 'malformed-header',
		})
	})
})
