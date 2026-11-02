import { afterEach, describe, expect, it, vi } from 'vitest'

import { GET, POST } from './route'

const url = 'http://localhost:3000/api/evergreen/claim'

describe('the evergreen claim route', () => {
	afterEach(() => {
		vi.unstubAllEnvs()
	})

	it('flag off: GET and POST both answer 404 without a cache', async () => {
		vi.stubEnv('AIH_DROVR_EVERGREEN_ENABLED', '')
		const responses = [
			await GET(new Request(url)),
			await POST(new Request(url, { method: 'POST' })),
		]
		expect(responses.map((response) => response.status)).toEqual([404, 404])
		expect(responses[0]?.headers.get('Cache-Control')).toBe('private, no-store')
	})
})
