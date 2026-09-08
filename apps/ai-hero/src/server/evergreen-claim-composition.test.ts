import { describe, it, expect, vi } from 'vitest'
import { composeEvergreenClaim } from './evergreen-claim-composition'
import { GET, POST } from '@/app/api/evergreen/claim/route'
describe('dormant claim route composition', () => {
	it('GET and POST refuse without a session/database/provider composition', async () => {
		vi.stubEnv('AIH_EVERGREEN_PILOT_CONFIG_JSON', '')
		for (const handler of [
			GET,
			POST,
			composeEvergreenClaim({ enabled: false }),
		]) {
			const response = await handler(
				new Request('https://example.test/api/evergreen/claim'),
			)
			expect(response.status).toBe(404)
			expect(response.headers.get('cache-control')).toContain('no-store')
		}
	})
})
