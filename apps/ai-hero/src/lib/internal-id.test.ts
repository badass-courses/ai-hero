import { describe, expect, it } from 'vitest'

import { createInternalId } from './internal-id'

describe('createInternalId', () => {
	it('creates 12-character lowercase base36 IDs', () => {
		for (let index = 0; index < 20; index++) {
			expect(createInternalId()).toMatch(/^[0-9a-z]{12}$/)
		}
	})
})
