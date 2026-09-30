import { afterEach, describe, expect, it, vi } from 'vitest'

import { GET, POST } from '@/app/api/evergreen/claim/route'

import { composeEvergreenClaim } from './evergreen-claim-composition'

// The live workshop page's claim panel GETs this route on every load
// (workshops/[module]/page.tsx). Which handler answers is the flag's call:
// drovr's claim with AIH_DROVR_EVERGREEN_ENABLED on (production since the
// drovr evergreen rollout), the dormant pilot's 404 otherwise. Row 205.
const ORIGIN = 'http://localhost:3000' // NEXT_PUBLIC_URL in src/test/setup.ts
const claimUrl = `${ORIGIN}/api/evergreen/claim`

const drovrOn = () => {
	vi.stubEnv('AIH_DROVR_EVERGREEN_ENABLED', 'true')
	vi.stubEnv('DROVR_SHADOW_INGEST_URL', 'https://drovr.test')
	vi.stubEnv('DROVR_API_KEY_ORG_AIHERO', 'test-authority-key')
}

describe('the evergreen claim route: which handler answers', () => {
	afterEach(() => {
		vi.unstubAllEnvs()
	})

	describe('drovr evergreen off: the dormant pilot', () => {
		it('GET and POST answer 404, never cached, with no pilot configured', async () => {
			vi.stubEnv('AIH_DROVR_EVERGREEN_ENABLED', '')
			vi.stubEnv('AIH_EVERGREEN_PILOT_CONFIG_JSON', '')
			for (const handler of [
				GET,
				POST,
				composeEvergreenClaim({ enabled: false }),
			]) {
				const response = await handler(new Request(claimUrl))
				expect(response.status).toBe(404)
				expect(response.headers.get('cache-control')).toContain('no-store')
			}
		})

		it('stays on the pilot when the flag is on but drovr is not configured', async () => {
			drovrOn()
			vi.stubEnv('DROVR_SHADOW_INGEST_URL', '')
			const response = await GET(new Request(claimUrl))
			expect(response.status).toBe(404)
		})
	})

	describe("drovr evergreen on: drovr's claim, as production answers", () => {
		it('asks a signed-out GET to sign in: 401 verification-needed', async () => {
			drovrOn()
			const response = await GET(new Request(claimUrl))
			expect(response.status).toBe(401)
			expect(await response.json()).toEqual({ status: 'verification-needed' })
			expect(response.headers.get('cache-control')).toContain('no-store')
		})

		it('refuses a query string: 400 unavailable', async () => {
			drovrOn()
			const response = await GET(new Request(`${claimUrl}?coupon=probe`))
			expect(response.status).toBe(400)
			expect(await response.json()).toEqual({ status: 'unavailable' })
		})

		it('refuses a POST from another origin: 403 unavailable', async () => {
			drovrOn()
			const response = await POST(
				new Request(claimUrl, {
					method: 'POST',
					headers: {
						origin: 'https://evil.test',
						'content-type': 'application/json',
					},
					body: '{}',
				}),
			)
			expect(response.status).toBe(403)
			expect(await response.json()).toEqual({ status: 'unavailable' })
		})
	})
})
