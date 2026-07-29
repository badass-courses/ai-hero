import { describe, expect, it, vi } from 'vitest'

import {
	buildMuxCourseSyncAssetInput,
	createCourseSyncMuxClient,
} from './mux-client'

describe('course-sync Mux client', () => {
	it('requests public plus-quality playback and the highest static rendition', () => {
		expect(
			buildMuxCourseSyncAssetInput({
				url: 'https://dropbox.test/video.mp4',
				passthrough: '{"v":"video-1"}',
			}),
		).toEqual({
			inputs: [
				{
					url: 'https://dropbox.test/video.mp4',
					generated_subtitles: [
						{ language_code: 'en', name: 'English CC' },
					],
				},
			],
			playback_policies: ['public'],
			video_quality: 'plus',
			max_resolution_tier: '2160p',
			static_renditions: [{ resolution: 'highest' }],
			passthrough: '{"v":"video-1"}',
		})
	})

	it('polls a created asset until public playback is ready', async () => {
		let reads = 0
		const fetchImpl = vi.fn(async (url: string | URL | Request) => {
			if (String(url).endsWith('/video/v1/assets')) {
				return new Response(
					JSON.stringify({ data: { id: 'mux-1', status: 'preparing' } }),
					{ status: 201 },
				)
			}
			reads += 1
			return new Response(
				JSON.stringify({
					data:
						reads === 1
							? { id: 'mux-1', status: 'preparing' }
							: {
								id: 'mux-1',
								status: 'ready',
								duration: 42,
								playback_ids: [{ id: 'playback-1', policy: 'public' }],
							},
				}),
				{ status: 200 },
			)
		}) as unknown as typeof fetch
		const sleep = vi.fn(async () => undefined)
		const client = createCourseSyncMuxClient({
			accessTokenId: 'token-id',
			secretKey: 'secret',
			fetchImpl,
			sleep,
			pollIntervalMs: 1,
			maxPollAttempts: 3,
		})

		const created = await client.createAsset({
			url: 'https://dropbox.test/video.mp4',
			passthrough: 'video-1',
		})
		await expect(client.waitForReady(created.id)).resolves.toEqual({
			id: 'mux-1',
			status: 'ready',
			playbackId: 'playback-1',
			duration: 42,
		})
		expect(sleep).toHaveBeenCalledTimes(1)
	})
})
