import { describe, expect, it } from 'vitest'

import { isCohortComingSoon } from './cohort-coming-soon'

describe('isCohortComingSoon', () => {
	it('is coming soon while the product is a draft', () => {
		expect(
			isCohortComingSoon({
				productState: 'draft',
				allowPurchase: undefined,
				hasCohortAccess: false,
			}),
		).toBe(true)
	})

	it('is not coming soon once the product is published', () => {
		expect(
			isCohortComingSoon({
				productState: 'published',
				allowPurchase: undefined,
				hasCohortAccess: false,
			}),
		).toBe(false)
	})

	it('respects the allowPurchase override', () => {
		expect(
			isCohortComingSoon({
				productState: 'draft',
				allowPurchase: 'true',
				hasCohortAccess: false,
			}),
		).toBe(false)
	})

	it('never shows the waitlist to someone who has the cohort', () => {
		expect(
			isCohortComingSoon({
				productState: 'draft',
				allowPurchase: undefined,
				hasCohortAccess: true,
			}),
		).toBe(false)
	})

	it('is not coming soon without a product', () => {
		expect(
			isCohortComingSoon({
				productState: undefined,
				allowPurchase: undefined,
				hasCohortAccess: false,
			}),
		).toBe(false)
	})
})
