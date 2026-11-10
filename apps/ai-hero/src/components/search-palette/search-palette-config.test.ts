import { describe, expect, it } from 'vitest'

import { PALETTE_PROMO } from './search-palette-config'

describe('search palette promo fallback', () => {
	it('promotes the next Software Factories cohort', () => {
		expect(PALETTE_PROMO).toEqual({
			label: 'Cohort',
			message:
				'Software Factories for Real Engineers, join the next live cohort',
			href: '/cohorts/software-factories-for-real-engineers-xdy1m',
		})
	})
})
