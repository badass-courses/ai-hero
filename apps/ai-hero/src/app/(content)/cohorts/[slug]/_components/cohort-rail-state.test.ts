import { describe, expect, it } from 'vitest'

import {
	getCohortEnrollmentWindow,
	getCohortMobileCta,
} from './cohort-rail-state'

const now = new Date('2026-10-12T12:00:00.000Z')
const before = '2026-10-01T07:00:00.000Z'
const after = '2026-10-26T07:01:00.000Z'
const later = '2026-11-10T07:30:00.000Z'

describe('getCohortEnrollmentWindow', () => {
	it('is not open before the opening date', () => {
		expect(
			getCohortEnrollmentWindow({
				openEnrollment: after,
				closeEnrollment: later,
				now,
			}),
		).toBe('not-open')
	})

	it('is open between the two dates, and without a closing date', () => {
		expect(
			getCohortEnrollmentWindow({
				openEnrollment: before,
				closeEnrollment: later,
				now,
			}),
		).toBe('open')
		expect(
			getCohortEnrollmentWindow({
				openEnrollment: before,
				closeEnrollment: null,
				now,
			}),
		).toBe('open')
	})

	it('is closed after the closing date', () => {
		expect(
			getCohortEnrollmentWindow({
				openEnrollment: '2026-09-01T07:00:00.000Z',
				closeEnrollment: before,
				now,
			}),
		).toBe('closed')
	})

	it('is closed when no opening date was ever set', () => {
		expect(
			getCohortEnrollmentWindow({
				openEnrollment: undefined,
				closeEnrollment: undefined,
				now,
			}),
		).toBe('closed')
	})

	it('opens for a coupon that bypasses the window', () => {
		expect(
			getCohortEnrollmentWindow({
				openEnrollment: after,
				closeEnrollment: later,
				bypassSoldOut: true,
				now,
			}),
		).toBe('open')
	})
})

describe('getCohortMobileCta', () => {
	const published = {
		hasCohortAccess: false,
		isComingSoon: false,
		isOnWaitlist: false,
		railHasOffer: true,
		hasActiveProduct: true,
		allowPurchase: undefined,
		enrollmentWindow: 'open' as const,
	}

	it('offers enrollment only while seats can be bought', () => {
		expect(getCohortMobileCta(published)).toBe('enroll')
		expect(
			getCohortMobileCta({ ...published, enrollmentWindow: 'not-open' }),
		).toBe('waitlist')
		expect(
			getCohortMobileCta({ ...published, enrollmentWindow: 'closed' }),
		).toBe('waitlist')
	})

	it('follows the allowPurchase override the rail follows', () => {
		expect(
			getCohortMobileCta({
				...published,
				enrollmentWindow: 'not-open',
				allowPurchase: 'true',
			}),
		).toBe('enroll')
	})

	it('stops asking someone who already joined the waitlist', () => {
		expect(
			getCohortMobileCta({
				...published,
				enrollmentWindow: 'not-open',
				isOnWaitlist: true,
			}),
		).toBe('on-waitlist')
		expect(
			getCohortMobileCta({
				...published,
				isComingSoon: true,
				railHasOffer: false,
				isOnWaitlist: true,
			}),
		).toBe('on-waitlist')
	})

	it('asks a coming-soon visitor to join the waitlist', () => {
		expect(
			getCohortMobileCta({
				...published,
				isComingSoon: true,
				railHasOffer: false,
			}),
		).toBe('waitlist')
	})

	it('never sells to someone who has the cohort', () => {
		expect(getCohortMobileCta({ ...published, hasCohortAccess: true })).toBe(
			'owned',
		)
	})

	it('shows nothing when there is no product to act on', () => {
		expect(
			getCohortMobileCta({ ...published, hasActiveProduct: false }),
		).toBe('none')
		expect(getCohortMobileCta({ ...published, railHasOffer: false })).toBe(
			'none',
		)
	})
})
