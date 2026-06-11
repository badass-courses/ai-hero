import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	list: vi.fn(),
}))

vi.mock('@/env.mjs', () => ({
	env: {
		YOUTUBE_OAUTH_CLIENT_ID: 'client-id',
		YOUTUBE_OAUTH_CLIENT_SECRET: 'client-secret',
		YOUTUBE_ANALYTICS_REFRESH_TOKEN: 'refresh-token',
	},
}))

vi.mock('google-auth-library', () => ({
	OAuth2Client: class OAuth2Client {
		setCredentials = vi.fn()
	},
}))

vi.mock('googleapis', () => ({
	google: {
		youtube: vi.fn(() => ({
			liveBroadcasts: {
				list: mocks.list,
			},
		})),
	},
}))

import { listYouTubeLiveBroadcasts } from '@/lib/youtube-live-broadcasts'

describe('YouTube live broadcasts', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.list.mockResolvedValue({ data: { items: [] } })
	})

	it('uses broadcastStatus without mine because YouTube rejects combining them', async () => {
		await listYouTubeLiveBroadcasts(3, 'upcoming')

		expect(mocks.list).toHaveBeenCalledWith({
			maxResults: 3,
			part: ['id', 'snippet', 'status', 'contentDetails'],
			broadcastStatus: 'upcoming',
		})
	})

	it('uses mine when no broadcast status filter is provided', async () => {
		await listYouTubeLiveBroadcasts(2)

		expect(mocks.list).toHaveBeenCalledWith({
			maxResults: 2,
			part: ['id', 'snippet', 'status', 'contentDetails'],
			mine: true,
		})
	})
})
