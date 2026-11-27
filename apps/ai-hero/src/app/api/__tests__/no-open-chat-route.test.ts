import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

// sec-20261127-170: the scaffold's /api/chat handler passed any anonymous
// caller's messages to a paid model. Nothing in the app used it. Keep any
// general-purpose chat route from coming back without auth by accident.
describe('/api/chat', () => {
	it('has no route handler', () => {
		const dir = join(__dirname, '..', 'chat')
		for (const ext of ['ts', 'tsx', 'js', 'mjs']) {
			expect(existsSync(join(dir, `route.${ext}`))).toBe(false)
		}
	})
})
