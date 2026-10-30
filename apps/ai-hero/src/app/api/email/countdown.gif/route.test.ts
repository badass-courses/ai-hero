import { GifReader } from 'omggif'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GET } from './route'

const NOW = new Date('2026-11-02T15:30:00Z')

function get(query: string) {
	return GET(
		new Request(`https://www.aihero.dev/api/email/countdown.gif${query}`),
	)
}

function expectNoCache(response: Response) {
	expect(response.headers.get('cache-control')).toBe(
		'no-store, no-cache, must-revalidate, max-age=0',
	)
	expect(response.headers.get('pragma')).toBe('no-cache')
	expect(response.headers.get('expires')).toBe('0')
	expect(response.headers.get('set-cookie')).toBeNull()
}

describe('GET /api/email/countdown.gif', () => {
	beforeEach(() => {
		vi.useFakeTimers()
		vi.setSystemTime(NOW)
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it('returns an uncached 60-frame GIF for a valid until', async () => {
		const response = get('?until=2026-11-03T07:59:59Z')
		expect(response.status).toBe(200)
		expect(response.headers.get('content-type')).toBe('image/gif')
		expectNoCache(response)

		const body = new Uint8Array(await response.arrayBuffer())
		expect(response.headers.get('content-length')).toBe(String(body.byteLength))
		expect(new GifReader(body).numFrames()).toBe(60)
	})

	it('returns one static frame after until', async () => {
		const response = get('?until=2026-11-01T00:00:00Z')
		expect(response.status).toBe(200)
		const body = new Uint8Array(await response.arrayBuffer())
		expect(new GifReader(body).numFrames()).toBe(1)
	})

	it.each([
		['no until', ''],
		['a malformed until', '?until=next-monday'],
		['an until past 60 days', '?until=2027-02-01T00:00:00Z'],
	])('returns an uncached 400 for %s', async (_label, query) => {
		const response = get(query)
		expect(response.status).toBe(400)
		expect(response.headers.get('content-type')).toContain('text/plain')
		expectNoCache(response)
	})
})
