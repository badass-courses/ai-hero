import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Signed Deepgram transcription callbacks (sec-059).
 *
 * Mirrors `@coursebuilder/core` providers/deepgram (label, TTL, skew), so a
 * later package bump verifies URLs signed here. Without a signature anyone
 * could POST a transcript for any video resource id.
 */
const LABEL = 'coursebuilder:transcription-callback:v2:'
export const TRANSCRIPTION_CALLBACK_TTL_SECONDS = 24 * 60 * 60
const SKEW_SECONDS = 5 * 60

const mac = (secret: string, videoResourceId: string, expiresAt: number) =>
	createHmac('sha256', secret)
		.update(`${LABEL}${videoResourceId}:${expiresAt}`)
		.digest('hex')

/** `getCallbackUrl` for DeepgramProvider: adds `exp` and `sig` to the callback. */
export function signedTranscriptionCallbackUrl(
	secret: string | undefined,
	nowSeconds: () => number = () => Math.floor(Date.now() / 1000),
) {
	return ({
		baseUrl,
		params,
	}: {
		baseUrl: string
		params: Record<string, string>
	}) => {
		const search = new URLSearchParams(params)
		const id = params.videoResourceId
		if (secret && id) {
			const exp = nowSeconds() + TRANSCRIPTION_CALLBACK_TTL_SECONDS
			search.set('exp', String(exp))
			search.set('sig', mac(secret, id, exp))
		}
		return `${baseUrl}?${search.toString()}`
	}
}

/** Constant-time check; refuses missing, malformed, expired or too-distant expiries. */
export function verifyTranscriptionCallback(
	secret: string | undefined,
	url: URL,
	nowSeconds: number = Math.floor(Date.now() / 1000),
): boolean {
	const id = url.searchParams.get('videoResourceId')
	const sig = url.searchParams.get('sig')
	const exp = url.searchParams.get('exp')
	if (!secret || !id || !sig || !exp || !/^\d{1,12}$/.test(exp)) return false
	const expiresAt = Number(exp)
	if (
		expiresAt < nowSeconds ||
		expiresAt > nowSeconds + TRANSCRIPTION_CALLBACK_TTL_SECONDS + SKEW_SECONDS
	)
		return false
	const expected = Buffer.from(mac(secret, id, expiresAt))
	const given = Buffer.from(sig)
	return expected.length === given.length && timingSafeEqual(expected, given)
}

export const isTranscriptionCallback = (url: URL) =>
	url.pathname.endsWith('/webhook/deepgram')
