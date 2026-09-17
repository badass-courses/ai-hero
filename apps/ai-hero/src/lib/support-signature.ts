import { createHmac, timingSafeEqual } from 'crypto'

/**
 * Verify a support-platform request signature.
 *
 * Same scheme as @skillrecordings/sdk's createSupportHandler (which keeps its
 * verification inline and unexported): header
 * `x-support-signature: timestamp=<unix>,v1=<hex hmac-sha256 of "<ts>.<body>">`
 * with a 5-minute replay window. Unlike the SDK, timestamps more than 5
 * minutes in the future are also rejected, so a forward-skewed signer cannot
 * mint signatures that stay valid far past signing time.
 */
export function verifySupportSignature({
	signatureHeader,
	bodyText,
	webhookSecret,
	nowSeconds = Math.floor(Date.now() / 1000),
}: {
	signatureHeader: string | null
	bodyText: string
	webhookSecret: string
	nowSeconds?: number
}): { valid: true } | { valid: false; error: string } {
	if (!signatureHeader) {
		return { valid: false, error: 'Missing signature header' }
	}

	const parts = signatureHeader.split(',')
	const timestampValue = parts
		.find((part) => part.startsWith('timestamp='))
		?.split('=')[1]
	const signatureValue = parts
		.find((part) => part.startsWith('v1='))
		?.split('=')[1]

	if (!timestampValue || !signatureValue) {
		return { valid: false, error: 'Invalid signature format' }
	}

	const timestamp = parseInt(timestampValue, 10)
	if (!Number.isFinite(timestamp)) {
		return { valid: false, error: 'Invalid signature format' }
	}

	const maxSkewSeconds = 300
	if (nowSeconds - timestamp > maxSkewSeconds) {
		return { valid: false, error: 'Signature expired' }
	}
	if (timestamp - nowSeconds > maxSkewSeconds) {
		return { valid: false, error: 'Signature timestamp is in the future' }
	}

	const expected = createHmac('sha256', webhookSecret)
		.update(`${timestamp}.${bodyText}`)
		.digest('hex')

	const received = Buffer.from(signatureValue)
	const expectedBuffer = Buffer.from(expected)
	if (
		received.length !== expectedBuffer.length ||
		!timingSafeEqual(received, expectedBuffer)
	) {
		return { valid: false, error: 'Invalid signature' }
	}

	return { valid: true }
}
