import { generateKeyPairSync, verify } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
	mintPlaybackTokens,
	selectLessonPlayback,
	signedPlaybackEnabled,
	SIGNED_PLAYBACK_TTL_SECONDS,
} from './signed-playback'

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
	modulusLength: 2048,
})
const pem = Buffer.from(
	privateKey.export({ type: 'pkcs8', format: 'pem' }),
).toString('base64')
const base = {
	resourceId: 'video-fixture',
	publicPlaybackId: 'public-fixture',
	signedPlaybackId: 'signed-fixture',
	canView: true,
	inPilot: true,
	flag: 'cohort-xdy1m',
	keyId: 'key-fixture',
	privateKey: pem,
}

describe('signed playback pilot', () => {
	it('signs verifiable RS256 tokens with kid, sub, separate audiences and six-hour expiry', () => {
		const tokens = mintPlaybackTokens({
			playbackId: 'signed-fixture',
			keyId: 'key-fixture',
			privateKey: pem,
			now: 1000,
		})
		for (const [kind, aud] of Object.entries({
			playback: 'v',
			thumbnail: 't',
			storyboard: 's',
		})) {
			const [header, claims, signature] = tokens[
				kind as keyof typeof tokens
			].split('.') as [string, string, string]
			expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({
				alg: 'RS256',
				typ: 'JWT',
				kid: 'key-fixture',
			})
			expect(JSON.parse(Buffer.from(claims, 'base64url').toString())).toEqual({
				sub: 'signed-fixture',
				aud,
				iat: 1000,
				exp: 1000 + SIGNED_PLAYBACK_TTL_SECONDS,
			})
			expect(
				verify(
					'RSA-SHA256',
					Buffer.from(`${header}.${claims}`),
					publicKey,
					Buffer.from(signature, 'base64url'),
				),
			).toBe(true)
		}
	})

	it('returns signed ID and all three tokens only for the enabled pilot', async () => {
		const log = vi.fn()
		const result = await selectLessonPlayback({ ...base, log })
		expect(result?.muxPlaybackId).toBe('signed-fixture')
		expect(Object.keys(result?.tokens ?? {})).toEqual([
			'playback',
			'thumbnail',
			'storyboard',
		])
		expect(log).toHaveBeenCalledWith('video.signed_playback.minted', {
			resourceId: base.resourceId,
			ms: expect.any(Number),
		})
	})

	it.each([
		{ flag: undefined },
		{ flag: '' },
		{ flag: 'another-cohort' },
		{ signedPlaybackId: null },
		{ inPilot: false },
	])('preserves public playback without minting: %j', async (override) => {
		const mint = vi.fn()
		expect(
			await selectLessonPlayback({ ...base, ...override, mint, log: vi.fn() }),
		).toEqual({ muxPlaybackId: base.publicPlaybackId })
		expect(mint).not.toHaveBeenCalled()
	})

	it.each([
		{ keyId: undefined },
		{ privateKey: undefined },
		{ privateKey: 'invalid' },
	])('falls back without exposing keys: %j', async (override) => {
		const log = vi.fn()
		expect(await selectLessonPlayback({ ...base, ...override, log })).toEqual({
			muxPlaybackId: base.publicPlaybackId,
		})
		expect(log).toHaveBeenCalledWith('video.signed_playback.fallback', {
			resourceId: base.resourceId,
			reason:
				override.privateKey === 'invalid' ? 'mint_failed' : 'missing_keys',
		})
	})

	it('falls back when mint throws', async () => {
		expect(
			await selectLessonPlayback({
				...base,
				mint: () => {
					throw new Error('secret')
				},
				log: vi.fn(),
			}),
		).toEqual({ muxPlaybackId: base.publicPlaybackId })
	})

	it('never mints or returns playback to a denied viewer', async () => {
		const mint = vi.fn()
		expect(
			await selectLessonPlayback({
				...base,
				canView: false,
				mint,
				log: vi.fn(),
			}),
		).toBeNull()
		expect(mint).not.toHaveBeenCalled()
	})

	it('requires the exact pilot cohort in a comma-separated allowlist', () => {
		expect(signedPlaybackEnabled(' other, cohort-xdy1m ')).toBe(true)
		expect(signedPlaybackEnabled('cohort-xdy1m-extra')).toBe(false)
	})
})
