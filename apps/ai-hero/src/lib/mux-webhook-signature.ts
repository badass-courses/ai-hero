import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Verifies a Mux webhook `mux-signature` header (`t=<unix seconds>,v1=<hex hmac>`).
 * The signed payload is `${t}.${rawBody}`, HMAC-SHA256 with the endpoint's signing secret.
 * See https://docs.mux.com/core/verify-webhook-signatures.
 */
export type MuxSignatureResult =
	| { ok: true }
	| {
			ok: false
			reason:
				| 'missing-secret'
				| 'missing-header'
				| 'malformed-header'
				| 'stale-timestamp'
				| 'bad-signature'
	  }

const DEFAULT_TOLERANCE_SECONDS = 300

export function verifyMuxSignature(input: {
	rawBody: string
	header: string | null
	secret: string | undefined
	nowMs?: number
	toleranceSeconds?: number
}): MuxSignatureResult {
	if (!input.secret) return { ok: false, reason: 'missing-secret' }
	if (!input.header) return { ok: false, reason: 'missing-header' }

	let timestamp: string | undefined
	const signatures: string[] = []
	for (const part of input.header.split(',')) {
		const [key, value] = part.split('=', 2).map((s) => s?.trim())
		if (key === 't') timestamp = value
		if (key === 'v1' && value) signatures.push(value)
	}
	if (!timestamp || !/^\d+$/.test(timestamp) || signatures.length === 0) {
		return { ok: false, reason: 'malformed-header' }
	}

	const nowSeconds = Math.floor((input.nowMs ?? Date.now()) / 1000)
	const tolerance = input.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS
	if (Math.abs(nowSeconds - Number(timestamp)) > tolerance) {
		return { ok: false, reason: 'stale-timestamp' }
	}

	const expected = Buffer.from(
		createHmac('sha256', input.secret)
			.update(`${timestamp}.${input.rawBody}`)
			.digest('hex'),
	)
	const matches = signatures.some((signature) => {
		const given = Buffer.from(signature)
		return given.length === expected.length && timingSafeEqual(given, expected)
	})
	return matches ? { ok: true } : { ok: false, reason: 'bad-signature' }
}
