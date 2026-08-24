import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	findCoupon: vi.fn(),
	getSaleBannerData: vi.fn(),
	getCachedMinimalWorkshop: vi.fn(),
	getUpcomingCohort: vi.fn(),
	getLatestCohort: vi.fn(),
	ne: vi.fn(),
}))

vi.mock('next/cache', () => ({
	unstable_cache: (operation: (...args: any[]) => unknown) => operation,
}))
vi.mock('drizzle-orm', () => ({
	and: vi.fn(),
	desc: vi.fn(),
	eq: vi.fn(),
	gte: vi.fn(),
	isNotNull: vi.fn(),
	ne: mocks.ne,
}))
vi.mock('@/db', () => ({
	db: { query: { coupon: { findFirst: mocks.findCoupon } } },
}))
vi.mock('@/db/schema', () => ({
	coupon: {
		status: 'status',
		default: 'default',
		expires: 'expires',
		percentageDiscount: 'percentageDiscount',
		restrictedToProductId: 'restrictedToProductId',
	},
}))
vi.mock('@/lib/courses-content', () => ({
	COURSES_COMING_NEXT: {
		title: 'AI Coding Crash Course',
		slug: 'ai-coding-crash-course',
	},
}))
vi.mock('@/lib/sale-banner', () => ({
	getSaleBannerData: mocks.getSaleBannerData,
}))
vi.mock('@/lib/workshops-query', () => ({
	getCachedMinimalWorkshop: mocks.getCachedMinimalWorkshop,
}))
vi.mock('@/server/logger', () => ({
	log: { error: vi.fn(() => Promise.resolve()) },
}))
vi.mock('./upcoming-cohort-query', () => ({
	getUpcomingCohort: mocks.getUpcomingCohort,
	getLatestCohort: mocks.getLatestCohort,
}))

import { getNextOffer } from './next-offer'

const crashCourseCoupon = {
	status: 1,
	default: true,
	restrictedToProductId: 'product-ma254',
	percentageDiscount: 0,
}

const crashCourseSale = {
	discountType: 'fixed',
	discountValue: 100,
	discountFormatted: '$100',
	productName: 'AI Coding Crash Course',
	productType: 'self-paced',
	productPath: '/workshops/ai-coding-crash-course',
	expires: '2026-08-25T06:59:59.000Z',
	resourceId: 'workshop-2ozd9',
	resourceType: 'workshop',
	resourceSlug: 'ai-coding-crash-course',
}

describe('getNextOffer Crash Course launch timing', () => {
	beforeEach(() => {
		vi.useFakeTimers()
		mocks.findCoupon.mockResolvedValue(crashCourseCoupon)
		mocks.getSaleBannerData.mockResolvedValue(crashCourseSale)
		mocks.getCachedMinimalWorkshop.mockResolvedValue(null)
		mocks.getUpcomingCohort.mockResolvedValue(null)
		mocks.getLatestCohort.mockResolvedValue(null)
	})

	afterEach(() => {
		vi.useRealTimers()
		vi.clearAllMocks()
	})

	it('suppresses the Crash Course sale before midnight Pacific', async () => {
		vi.setSystemTime(new Date('2026-08-17T06:59:59.999Z'))

		expect(await getNextOffer()).toBeNull()
		expect(mocks.getSaleBannerData).not.toHaveBeenCalled()
	})

	it('keeps unrelated product sales visible before launch', async () => {
		vi.setSystemTime(new Date('2026-08-17T06:59:59.999Z'))
		const otherCoupon = {
			...crashCourseCoupon,
			restrictedToProductId: 'product-other',
		}
		mocks.findCoupon.mockResolvedValue(otherCoupon)
		mocks.getSaleBannerData.mockResolvedValue({
			...crashCourseSale,
			productName: 'Other Course',
			productPath: '/workshops/other-course',
			resourceId: 'workshop-other',
		})

		expect(await getNextOffer()).toMatchObject({
			kind: 'sale',
			id: 'workshop-other',
			href: '/workshops/other-course',
		})
		expect(mocks.ne).toHaveBeenCalledWith(
			'restrictedToProductId',
			'product-ma254',
		)
	})

	it('exposes the Crash Course sale at midnight Pacific', async () => {
		vi.setSystemTime(new Date('2026-08-17T07:00:00.000Z'))

		expect(await getNextOffer()).toMatchObject({
			kind: 'sale',
			id: 'workshop-2ozd9',
			href: '/workshops/ai-coding-crash-course',
			label: 'Save $100',
		})
		expect(mocks.getSaleBannerData).toHaveBeenCalledWith(crashCourseCoupon)
	})
})
