import {
	toPublicYouTubeLiveBroadcast,
	type PublicYouTubeLiveBroadcast,
} from '@/lib/youtube-live-schedule'
import type { YouTubeLiveBroadcast } from '@/lib/youtube-live-broadcasts'
import { describe, expect, it } from 'vitest'

function makeBroadcast(
	overrides: Partial<YouTubeLiveBroadcast> = {},
): YouTubeLiveBroadcast {
	return {
		id: 'broadcast-1',
		title: 'Build AI agents live',
		description: 'A live workshop.',
		scheduledStartTime: '2026-05-08T17:00:00.000Z',
		scheduledEndTime: '2026-05-08T18:00:00.000Z',
		actualStartTime: null,
		actualEndTime: null,
		lifeCycleStatus: 'ready',
		privacyStatus: 'public',
		boundStreamId: 'stream-1',
		watchUrl: 'https://www.youtube.com/watch?v=broadcast-1',
		raw: {},
		...overrides,
	}
}

describe('YouTube live schedule helpers', () => {
	it('normalizes public broadcasts for the homepage', () => {
		const result = toPublicYouTubeLiveBroadcast(
			makeBroadcast({ privacyStatus: 'public' }),
			'live',
		)

		expect(result).toEqual({
			id: 'broadcast-1',
			title: 'Build AI agents live',
			description: 'A live workshop.',
			scheduledStartTime: '2026-05-08T17:00:00.000Z',
			scheduledEndTime: '2026-05-08T18:00:00.000Z',
			actualStartTime: null,
			actualEndTime: null,
			lifeCycleStatus: 'ready',
			privacyStatus: 'public',
			status: 'live',
			watchUrl: 'https://www.youtube.com/watch?v=broadcast-1',
		} satisfies PublicYouTubeLiveBroadcast)
	})

	it('filters unlisted broadcasts', () => {
		expect(
			toPublicYouTubeLiveBroadcast(
				makeBroadcast({ privacyStatus: 'unlisted' }),
				'live',
			),
		).toBeNull()
	})

	it('filters private broadcasts', () => {
		expect(
			toPublicYouTubeLiveBroadcast(
				makeBroadcast({ privacyStatus: 'private' }),
				'live',
			),
		).toBeNull()
	})
})
