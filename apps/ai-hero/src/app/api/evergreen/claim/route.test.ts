import { afterEach, describe, expect, it, vi } from 'vitest'

// Which handler the route calls, by spy rather than by status: with the
// pilot unconfigured both handlers answer 404, so only a spy tells them
// apart (row 205, #342 review). Each spy answers a marker status.
const mocks = vi.hoisted(() => ({
	pilot: vi.fn(
		async (_request: Request) => new Response(null, { status: 299 }),
	),
	drovr: vi.fn(
		async (_request: Request) => new Response(null, { status: 298 }),
	),
}))

vi.mock('@/server/evergreen-claim-composition', () => ({
	evergreenClaimHandler: mocks.pilot,
}))
vi.mock('@/server/drovr-evergreen-claim', async (importOriginal) => ({
	// The real flag read: the route's dispatch is what is under test.
	...(await importOriginal<typeof import('@/server/drovr-evergreen-claim')>()),
	drovrEvergreenClaimHandler: mocks.drovr,
}))

import { drovrEvergreenClaimEnabled } from '@/server/drovr-evergreen-claim'

import { GET, POST } from './route'

const url = 'http://localhost:3000/api/evergreen/claim'
const both = async () => [
	(await GET(new Request(url))).status,
	(await POST(new Request(url, { method: 'POST' }))).status,
]

describe('the evergreen claim route dispatch (row 205)', () => {
	afterEach(() => {
		vi.unstubAllEnvs()
		mocks.pilot.mockClear()
		mocks.drovr.mockClear()
	})

	it('flag off: GET and POST both reach the pilot, never drovr', async () => {
		vi.stubEnv('AIH_DROVR_EVERGREEN_ENABLED', '')
		expect(drovrEvergreenClaimEnabled()).toBe(false)
		expect(await both()).toEqual([299, 299])
		expect(mocks.pilot).toHaveBeenCalledTimes(2)
		expect(mocks.drovr).not.toHaveBeenCalled()
	})

	it('flag on: GET and POST both reach drovr, never the pilot', async () => {
		vi.stubEnv('AIH_DROVR_EVERGREEN_ENABLED', 'true')
		vi.stubEnv('DROVR_SHADOW_INGEST_URL', 'https://drovr.test')
		vi.stubEnv('DROVR_API_KEY_ORG_AIHERO', 'test-authority-key')
		expect(drovrEvergreenClaimEnabled()).toBe(true)
		expect(await both()).toEqual([298, 298])
		expect(mocks.drovr).toHaveBeenCalledTimes(2)
		expect(mocks.pilot).not.toHaveBeenCalled()
	})
})
