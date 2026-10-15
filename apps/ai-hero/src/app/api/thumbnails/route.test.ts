import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	getVideoResource: vi.fn(),
	getAuthoredThumbnailTimes: vi.fn(),
	fetch: vi.fn(),
	log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}))

vi.mock('@/lib/video-resource-query', () => ({
	getVideoResource: mocks.getVideoResource,
}))
vi.mock('@/server/logger', () => ({ log: mocks.log }))
vi.mock('@/server/with-skill', () => ({
	withSkill: (handler: unknown) => handler,
}))
vi.mock('./thumbnail-time', async (importOriginal) => ({
	...(await importOriginal<typeof import('./thumbnail-time')>()),
	getAuthoredThumbnailTimes: mocks.getAuthoredThumbnailTimes,
}))
vi.mock('@/db', () => ({ db: {} }))

import { GET } from './route'
import { resolveThumbnailTime } from './thumbnail-time'

const PLAYBACK_ID = 'playback_test_only'

function call(query: string) {
	return GET(new NextRequest(`http://localhost:3000/api/thumbnails?${query}`))
}

/** The Mux still the route fetched. */
function muxUrl() {
	return new URL(mocks.fetch.mock.calls[0]![0] as string)
}

beforeEach(() => {
	vi.clearAllMocks()
	vi.stubGlobal('fetch', mocks.fetch)
	mocks.fetch.mockResolvedValue(new Response(new Uint8Array([1, 2, 3])))
	mocks.getVideoResource.mockResolvedValue({
		id: 'video_1',
		muxPlaybackId: PLAYBACK_ID,
	})
	mocks.getAuthoredThumbnailTimes.mockResolvedValue([61.238155])
})

describe('resolveThumbnailTime', () => {
	it('serves frame 0 and authored times, within the index’s rounding', () => {
		expect(resolveThumbnailTime('0', [61.2], 5)).toBe(0)
		expect(resolveThumbnailTime('61.2', [61.2], 5)).toBe(61.2)
		expect(resolveThumbnailTime('61', [61.2], 5)).toBe(61)
	})

	it('falls back to the default poster for anything else', () => {
		expect(resolveThumbnailTime(null, [61.2], 5)).toBe(5)
		expect(resolveThumbnailTime('150', [61.2], 5)).toBe(5)
		expect(resolveThumbnailTime('150', [], 0)).toBe(0)
		expect(resolveThumbnailTime('-1', [61.2], 5)).toBe(5)
		expect(resolveThumbnailTime('1&width=1920', [61.2], 5)).toBe(5)
		expect(resolveThumbnailTime('abc', [61.2], 5)).toBe(5)
	})
})

describe('GET /api/thumbnails', () => {
	it('serves the authored poster frame, cached forever', async () => {
		const res = await call(
			'videoResourceId=video_1&time=61.238155&width=720',
		)

		expect(res.status).toBe(200)
		expect(res.headers.get('cache-control')).toBe(
			'public, max-age=31536000, immutable',
		)
		expect(muxUrl().pathname).toBe(`/${PLAYBACK_ID}/thumbnail.png`)
		expect(muxUrl().searchParams.get('time')).toBe('61.238155')
		expect(muxUrl().searchParams.get('width')).toBe('720')
	})

	it('serves frame 0 without looking up the authored times', async () => {
		await call('videoResourceId=video_1&time=0&width=720')

		expect(muxUrl().searchParams.get('time')).toBe('0')
		expect(mocks.getAuthoredThumbnailTimes).not.toHaveBeenCalled()
	})

	it('serves the default poster when no time is asked for', async () => {
		await call('videoResourceId=video_1')

		expect(muxUrl().searchParams.get('time')).toBe('0')
		expect(muxUrl().searchParams.get('width')).toBe('320')
	})

	it('never serves an arbitrary frame of the video', async () => {
		await call('videoResourceId=video_1&time=150&width=720')

		expect(mocks.getAuthoredThumbnailTimes).toHaveBeenCalledWith('video_1')
		expect(muxUrl().searchParams.get('time')).toBe('0')
	})

	it('cannot smuggle Mux parameters through time', async () => {
		await call(
			`videoResourceId=video_1&time=${encodeURIComponent('61.238155&width=1920')}`,
		)

		expect(muxUrl().searchParams.getAll('width')).toEqual(['320'])
		expect(muxUrl().searchParams.get('time')).toBe('0')
	})
})
