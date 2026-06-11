import crypto from 'node:crypto'

const SLACK_REPLAY_WINDOW_SECONDS = 60 * 5

function timingSafeEqual(a: string, b: string) {
	const aBuffer = Buffer.from(a)
	const bBuffer = Buffer.from(b)
	return (
		aBuffer.length === bBuffer.length &&
		crypto.timingSafeEqual(aBuffer, bBuffer)
	)
}

/**
 * Verifies a Slack request signature against the supplied signing secret.
 * Implements Slack's documented v0 HMAC-SHA256 scheme with a 5-minute
 * replay window. Caller must read the raw body first via `await req.text()`
 * before any parser touches it.
 *
 * The signing secret is a required argument (not env-defaulted) so multiple
 * Slack apps in the same codebase can each verify against their own secret.
 */
export function verifySlackSignature(
	request: Request,
	rawBody: string,
	signingSecret: string,
): boolean {
	if (!signingSecret) return false

	const timestamp = request.headers.get('x-slack-request-timestamp')
	const signature = request.headers.get('x-slack-signature')

	if (!timestamp || !signature) return false

	const timestampSeconds = Number(timestamp)
	if (!Number.isFinite(timestampSeconds)) return false

	const nowSeconds = Math.floor(Date.now() / 1000)
	if (Math.abs(nowSeconds - timestampSeconds) > SLACK_REPLAY_WINDOW_SECONDS)
		return false

	const baseString = `v0:${timestamp}:${rawBody}`
	const expectedSignature = `v0=${crypto
		.createHmac('sha256', signingSecret)
		.update(baseString, 'utf8')
		.digest('hex')}`

	return timingSafeEqual(expectedSignature, signature)
}

/**
 * Extracts the JSON `payload` field from a Slack interactivity request body.
 * Slack POSTs interactivity payloads as `application/x-www-form-urlencoded`
 * with the JSON encoded under a single `payload` key.
 *
 * Returns null when the body does not contain a `payload` field or the JSON
 * is malformed; callers should treat null as a 400 condition.
 */
export function parseSlackInteractivityPayload(
	rawBody: string,
): unknown | null {
	const form = new URLSearchParams(rawBody)
	const payloadText = form.get('payload')
	if (!payloadText) return null
	try {
		return JSON.parse(payloadText)
	} catch {
		return null
	}
}
