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
		expect(FEATURED_PROMO.navLabel).toBe('Get the course')
		expect(FEATURED_PROMO.navHref).toBe(
			'/workshops/ai-coding-crash-course',
		)
		expect(FEATURED_PROMO.startsAt).toBe(CRASH_COURSE_PROMO_STARTS_AT)
		expect(FEATURED_PROMO.message).toBe('AI Coding Crash Course is out now.')
	})

	/**
	 * The rule the launch copy broke: the bar promised "$199 through August 24"
	 * for a day after the intro coupon lapsed, because nothing tied the claim to
	 * a clock. A promo may name a price or a date, but then it has to say when it
	 * stops being true — and the same goes for the nav's gold label, which is the
	 * same assertion in four words ("Save $100").
	 */
	it('never makes a priced or dated claim without an expiry', () => {
		const claims = [FEATURED_PROMO.message, FEATURED_PROMO.navLabel]
			.filter(Boolean)
			.join(' ')
		const isTimeBound = /\$\d|\d+%|\bJanuary\b|\bFebruary\b|\bMarch\b|\bApril\b|\bMay\b|\bJune\b|\bJuly\b|\bAugust\b|\bSeptember\b|\bOctober\b|\bNovember\b|\bDecember\b/i.test(
			claims,
		)

		if (isTimeBound) {
			expect(
				FEATURED_PROMO.endsAt,
				`"${claims}" names a price or date, so it needs an endsAt`,
			).toBeDefined()
		}
	})
})
