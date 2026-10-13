import { describe, expect, it } from 'vitest'

import { formatOpensIn, upcomingEnrollmentOpening } from './cohort-opening'

const now = new Date('2026-10-13T12:00:00.000Z')

describe('upcomingEnrollmentOpening', () => {
	it('is the opening date while enrollment is still ahead', () => {
		expect(
			upcomingEnrollmentOpening({ opensAt: '2026-10-26T07:01:00.000Z' }, now),
		).toEqual(new Date('2026-10-26T07:01:00.000Z'))
	})

	it('is null once enrollment has opened', () => {
		expect(
			upcomingEnrollmentOpening({ opensAt: '2026-10-01T07:01:00.000Z' }, now),
		).toBeNull()
	})

	it('is null at the opening instant, when seats are on sale', () => {
		expect(
			upcomingEnrollmentOpening({ opensAt: now.toISOString() }, now),
		).toBeNull()
	})

	it('is null without a date, a cohort, or a readable date', () => {
		expect(upcomingEnrollmentOpening({}, now)).toBeNull()
		expect(upcomingEnrollmentOpening(null, now)).toBeNull()
		expect(upcomingEnrollmentOpening({ opensAt: 'soon' }, now)).toBeNull()
	})
})

describe('formatOpensIn', () => {
	const PT = 'America/Los_Angeles'
	const opens = new Date('2026-10-26T07:01:00.000Z')

	it('counts days, rounded up, then gives the moment in the cohort zone', () => {
		expect(formatOpensIn(opens, PT, now)).toBe(
			'in 13 days (Oct 26 at 12:01 AM PDT)',
		)
		expect(
			formatOpensIn(opens, PT, new Date('2026-10-24T06:00:00.000Z')),
		).toBe('in 3 days (Oct 26 at 12:01 AM PDT)')
	})

	it('counts hours inside the last day', () => {
		expect(
			formatOpensIn(opens, PT, new Date('2026-10-25T07:01:00.000Z')),
		).toBe('in 24 hours (Oct 26 at 12:01 AM PDT)')
		expect(
			formatOpensIn(opens, PT, new Date('2026-10-26T04:31:00.000Z')),
		).toBe('in 3 hours (Oct 26 at 12:01 AM PDT)')
		expect(
			formatOpensIn(opens, PT, new Date('2026-10-26T06:45:00.000Z')),
		).toBe('in 1 hour (Oct 26 at 12:01 AM PDT)')
	})

	it('prints the moment in the cohort zone, not UTC', () => {
		// 06:30 UTC on the 26th is still the 25th in Los Angeles.
		expect(
			formatOpensIn(new Date('2026-10-26T06:30:00.000Z'), PT, now),
		).toBe('in 13 days (Oct 25 at 11:30 PM PDT)')
	})

	it('names the year when it is not this one', () => {
		expect(
			formatOpensIn(new Date('2027-01-11T08:01:00.000Z'), PT, now),
		).toBe('in 90 days (Jan 11, 2027 at 12:01 AM PST)')
	})

	it('is the moment alone once the opening has passed', () => {
		expect(
			formatOpensIn(opens, PT, new Date('2026-10-27T00:00:00.000Z')),
		).toBe('Oct 26 at 12:01 AM PDT')
	})
})
