import crypto from 'node:crypto'
import {
	parseSlackInteractivityPayload,
	verifySlackSignature,
} from '@/utils/verify-slack-signature'
import { describe, expect, it } from 'vitest'

const SIGNING_SECRET = 'test_signing_secret'

function makeSignedRequest(
	rawBody: string,
	{
		timestamp,
		secret = SIGNING_SECRET,
		tamper = false,
	}: { timestamp?: number; secret?: string; tamper?: boolean } = {},
) {
	const ts = String(timestamp ?? Math.floor(Date.now() / 1000))
	const signature = `v0=${crypto
		.createHmac('sha256', secret)
		.update(`v0:${ts}:${rawBody}`, 'utf8')
		.digest('hex')}`
	const headers = new Headers({
		'x-slack-request-timestamp': ts,
		'x-slack-signature': tamper ? 'v0=00deadbeef' : signature,
	})
	return new Request('https://example.test/slack', {
		method: 'POST',
		headers,
		body: rawBody,
	})
}

describe('verifySlackSignature', () => {
	it('returns true for a freshly signed request', () => {
		const body = 'payload=%7B%22type%22%3A%22block_actions%22%7D'
		const req = makeSignedRequest(body)
		expect(verifySlackSignature(req, body, SIGNING_SECRET)).toBe(true)
	})

	it('returns false for a stale timestamp (>5 min)', () => {
		const body = 'payload=stale'
		const stale = Math.floor(Date.now() / 1000) - 60 * 6
		const req = makeSignedRequest(body, { timestamp: stale })
		expect(verifySlackSignature(req, body, SIGNING_SECRET)).toBe(false)
	})

	it('returns false when the signature does not match the body', () => {
		const body = 'payload=valid'
		const req = makeSignedRequest(body)
		expect(verifySlackSignature(req, 'payload=tampered', SIGNING_SECRET)).toBe(
			false,
		)
	})

	it('returns false when the signature header is missing', () => {
		const body = 'payload=missing'
		const req = new Request('https://example.test/slack', {
			method: 'POST',
			headers: { 'x-slack-request-timestamp': '1700000000' },
			body,
		})
		expect(verifySlackSignature(req, body, SIGNING_SECRET)).toBe(false)
	})

	it('returns false when called with a different signing secret', () => {
		const body = 'payload=cross-secret'
		const req = makeSignedRequest(body, { secret: 'other_secret' })
		expect(verifySlackSignature(req, body, SIGNING_SECRET)).toBe(false)
	})

	it('returns false when the signing secret is empty', () => {
		const body = 'payload=empty-secret'
		const req = makeSignedRequest(body)
		expect(verifySlackSignature(req, body, '')).toBe(false)
	})
})

describe('parseSlackInteractivityPayload', () => {
	it('extracts and parses the JSON payload field', () => {
		const json = { type: 'block_actions', actions: [{ action_id: 'go' }] }
		const body = `payload=${encodeURIComponent(JSON.stringify(json))}`
		expect(parseSlackInteractivityPayload(body)).toEqual(json)
	})

	it('returns null when payload key is missing', () => {
		expect(parseSlackInteractivityPayload('foo=bar')).toBeNull()
	})

	it('returns null when payload is malformed JSON', () => {
		expect(parseSlackInteractivityPayload('payload=not-json')).toBeNull()
	})
})
