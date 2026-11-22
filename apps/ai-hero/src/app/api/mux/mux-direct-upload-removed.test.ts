import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('POST /api/mux is gone (sec-048)', () => {
	it('has no unauthenticated direct-upload route', () => {
		// It minted a signed Mux direct-upload URL on our account for anyone,
		// with no session or token check. Nothing in the app called it; video
		// uploads go through the authenticated uploadthing route. The webhook
		// in ./webhook stays.
		expect(existsSync(join(__dirname, 'route.ts'))).toBe(false)
		expect(existsSync(join(__dirname, 'webhook', 'route.ts'))).toBe(true)
	})
})
