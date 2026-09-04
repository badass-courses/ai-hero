import { createHmac } from 'crypto'
import { describe, expect, it } from 'vitest'

import { verifySupportSignature } from './support-signature'

const SECRET = 'test-support-secret'

function sign(bodyText: string, timestamp: number, secret = SECRET) {
	const signature = createHmac('sha256', secret)
		.update(`${timestamp}.${bodyText}`)
		.digest('hex')
	return `timestamp=${timestamp},v1=${signature}`
}

describe('verifySupportSignature', () => {
	const body = JSON.stringify({ merchantChargeId: 'mch_1' })
	const now = 1_700_000_000

	it('accepts a valid signature', () => {
		const result = verifySupportSignature({
			signatureHeader: sign(body, now),
			bodyText: body,
			webhookSecret: SECRET,
			nowSeconds: now,
		})
		expect(result.valid).toBe(true)
	})

	it('rejects a missing header', () => {
		const result = verifySupportSignature({
			signatureHeader: null,
			bodyText: body,
			webhookSecret: SECRET,
			nowSeconds: now,
		})
		expect(result.valid).toBe(false)
	})

	it('rejects a malformed header', () => {
		const result = verifySupportSignature({
			signatureHeader: 'v1=abc',
			bodyText: body,
			webhookSecret: SECRET,
			nowSeconds: now,
		})
		expect(result.valid).toBe(false)
	})

	it('rejects a signature made with the wrong secret', () => {
		const result = verifySupportSignature({
			signatureHeader: sign(body, now, 'wrong-secret'),
			bodyText: body,
			webhookSecret: SECRET,
			nowSeconds: now,
		})
		expect(result.valid).toBe(false)
	})

	it('rejects a signature over a different body', () => {
		const result = verifySupportSignature({
			signatureHeader: sign('{"merchantChargeId":"mch_2"}', now),
			bodyText: body,
			webhookSecret: SECRET,
			nowSeconds: now,
		})
		expect(result.valid).toBe(false)
	})

	it('rejects an expired signature', () => {
		const result = verifySupportSignature({
			signatureHeader: sign(body, now - 301),
			bodyText: body,
			webhookSecret: SECRET,
			nowSeconds: now,
		})
		expect(result.valid).toBe(false)
		if (!result.valid) expect(result.error).toBe('Signature expired')
	})

	it('rejects a timestamp more than five minutes in the future', () => {
		const result = verifySupportSignature({
			signatureHeader: sign(body, now + 301),
			bodyText: body,
			webhookSecret: SECRET,
			nowSeconds: now,
		})
		expect(result.valid).toBe(false)
		if (!result.valid) {
			expect(result.error).toBe('Signature timestamp is in the future')
		}
	})

	it('accepts small clock skew in both directions', () => {
		for (const timestamp of [now - 299, now + 299]) {
			const result = verifySupportSignature({
				signatureHeader: sign(body, timestamp),
				bodyText: body,
				webhookSecret: SECRET,
				nowSeconds: now,
			})
			expect(result.valid).toBe(true)
		}
	})
})
