import { describe, expect, it } from 'vitest'

import {
	CRASH_COURSE_PRODUCT_ID,
	CRASH_COURSE_PROMO_STARTS_AT,
	FEATURED_PROMO,
	isProductPromoActive,
	isPromoActive,
} from './promo-config'

const ONE_MILLISECOND_BEFORE = new Date('2026-08-17T06:59:59.999Z')
const MIDNIGHT_PACIFIC = new Date('2026-08-17T07:00:00.000Z')

describe('Crash Course promotion timing', () => {
	it('keeps the featured promo hidden until midnight Pacific', () => {
		expect(isPromoActive(FEATURED_PROMO, ONE_MILLISECOND_BEFORE)).toBe(
			false,
		)
		expect(isPromoActive(FEATURED_PROMO, MIDNIGHT_PACIFIC)).toBe(true)
	})

	it('keeps only the Crash Course sale out of global offer surfaces', () => {
		expect(
			isProductPromoActive(
				CRASH_COURSE_PRODUCT_ID,
				ONE_MILLISECOND_BEFORE,
			),
		).toBe(false)
		expect(
			isProductPromoActive(CRASH_COURSE_PRODUCT_ID, MIDNIGHT_PACIFIC),
		).toBe(true)
		expect(isProductPromoActive('product-other', ONE_MILLISECOND_BEFORE)).toBe(
			true,
		)
	})

	it('uses the tracked launch link and exact launch instant', () => {
		expect(FEATURED_PROMO.href).toBe('/s/crash-course')
		expect(FEATURED_PROMO.resourceId).toBe('workshop-2ozd9')
		expect(FEATURED_PROMO.navLabel).toBe('Save $100')
		expect(FEATURED_PROMO.navHref).toBe(
			'/workshops/ai-coding-crash-course',
		)
		expect(FEATURED_PROMO.startsAt).toBe(CRASH_COURSE_PROMO_STARTS_AT)
		expect(FEATURED_PROMO.message).toBe(
			'AI Coding Crash Course is open. $199 through August 24.',
		)
	})
})
