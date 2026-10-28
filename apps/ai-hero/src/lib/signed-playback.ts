import { createPrivateKey, sign } from 'node:crypto'

export type PlaybackTokens = {
	playback: string
	thumbnail: string
	storyboard: string
}

export const SIGNED_PLAYBACK_TTL_SECONDS = 6 * 60 * 60
export const SIGNED_PLAYBACK_COHORT = 'cohort-xdy1m'

export function signedPlaybackEnabled(flag: string | undefined) {
	return (flag ?? '')
		.split(',')
		.map((id) => id.trim())
		.includes(SIGNED_PLAYBACK_COHORT)
}

/** Server callers only. Each Mux resource needs its own audience. */
export function mintPlaybackTokens({
	playbackId,
	keyId,
	privateKey,
	now = Math.floor(Date.now() / 1000),
}: {
	playbackId: string
	keyId: string
	/** Base64-encoded PEM, never sent to the browser. */
	privateKey: string
	now?: number
}): PlaybackTokens {
	const key = createPrivateKey(Buffer.from(privateKey, 'base64'))
	if (key.asymmetricKeyType !== 'rsa')
		throw new Error('Signing key must be RSA')
	const encode = (value: object) =>
		Buffer.from(JSON.stringify(value)).toString('base64url')
	const token = (aud: string) => {
		const input = `${encode({ alg: 'RS256', typ: 'JWT', kid: keyId })}.${encode(
			{
				sub: playbackId,
				aud,
				iat: now,
				exp: now + SIGNED_PLAYBACK_TTL_SECONDS,
			},
		)}`
		return `${input}.${sign('RSA-SHA256', Buffer.from(input), key).toString('base64url')}`
	}
	return {
		playback: token('v'),
		thumbnail: token('t'),
		storyboard: token('s'),
	}
}

export async function selectLessonPlayback({
	resourceId,
	publicPlaybackId,
	signedPlaybackId,
	canView,
	inPilot,
	flag,
	keyId,
	privateKey,
	mint = mintPlaybackTokens,
	log,
}: {
	resourceId: string
	publicPlaybackId: string
	signedPlaybackId?: string | null
	canView: boolean
	inPilot: boolean
	flag?: string
	keyId?: string
	privateKey?: string
	mint?: typeof mintPlaybackTokens
	log: (event: string, data: Record<string, string | number>) => void
}): Promise<{ muxPlaybackId: string; tokens?: PlaybackTokens } | null> {
	if (!canView) return null
	const fallback = { muxPlaybackId: publicPlaybackId }
	if (!signedPlaybackEnabled(flag) || !inPilot || !signedPlaybackId)
		return fallback
	if (!keyId || !privateKey) {
		log('video.signed_playback.fallback', {
			resourceId,
			reason: 'missing_keys',
		})
		return fallback
	}
	const start = performance.now()
	try {
		const tokens = mint({ playbackId: signedPlaybackId, keyId, privateKey })
		log('video.signed_playback.minted', {
			resourceId,
			ms: Math.round(performance.now() - start),
		})
		return { muxPlaybackId: signedPlaybackId, tokens }
	} catch {
		// Never log the exception: crypto errors can contain key material.
		log('video.signed_playback.fallback', {
			resourceId,
			reason: 'mint_failed',
		})
		return fallback
	}
}
