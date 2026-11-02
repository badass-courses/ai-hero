import { describe, expect, it } from 'vitest'
import {
	CRASH_COURSE_PROMO,
	FEATURED_PROMO,
	getFeaturedPromo,
} from '@/components/navigation/promo-config'

import { isC5OnSale } from './c5-on-sale'

describe('C5 sitewide sale', () => {
	it.each([
		['2026-10-25T18:58:59.999Z', false],
		['2026-10-25T18:59:00.000Z', true],
		['2026-11-01T12:00:00.000Z', true],
		['2026-11-10T07:59:58.999Z', true],
		['2026-11-10T07:59:59.000Z', false],
		['2026-11-11T12:00:00.000Z', false],
	])('uses the half-open sale window at %s', (instant, expected) => {
		const now = new Date(instant)
		expect(isC5OnSale(now)).toBe(expected)
		expect(getFeaturedPromo(now)).toBe(
			expected ? FEATURED_PROMO : CRASH_COURSE_PROMO,
		)
	})

	it('restores the current promo when pricing is disabled', () => {
		const now = new Date('2026-11-01T12:00:00.000Z')
		expect(isC5OnSale(now, true)).toBe(false)
		expect(getFeaturedPromo(now, true)).toBe(CRASH_COURSE_PROMO)
	})

	it('keeps tracking, page suppression and ownership on the same cohort', () => {
		expect(FEATURED_PROMO.href).toBe('/s/c5-site-banner')
		expect(FEATURED_PROMO.resourceId).toBe('cohort-xdy1m')
		expect(FEATURED_PROMO.navHref).toBe(
			'/cohorts/software-factories-for-real-engineers-xdy1m',
		)
		expect(FEATURED_PROMO.message).toBe(
			'Software Factories for Real Engineers: enrollment is open.',
		)
		expect(`${FEATURED_PROMO.message} ${FEATURED_PROMO.navLabel}`).not.toMatch(
			/\$|%|—/,
		)
	})
})
