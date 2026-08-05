import { describe, expect, it } from 'vitest'

import { formatCohortDateRange } from './format-cohort-date'

describe('formatCohortDateRange', () => {
	it('formats a start-only date', () => {
		expect(
			formatCohortDateRange('2026-06-01T07:01:00.000Z', null, 'UTC').dateString,
		).toBe('June 1, 2026')
	})

	it('returns nulls when there is no date', () => {
		expect(formatCohortDateRange(null, null, 'UTC')).toEqual({
			dateString: null,
			timeString: null,
		})
	})

	/**
	 * `startsAt` is authored freehand in the CMS, and `formatInTimeZone` throws
	 * `RangeError: Invalid time value` on an Invalid Date — so one malformed
	 * field used to take down every tree that rendered it, including the
	 * workshop sidebar. Nulls are what this function already returns for an
	 * absent date; unparseable is the same non-answer.
	 */
	it('returns nulls for an unparseable start date instead of throwing', () => {
		expect(() => formatCohortDateRange('not-a-date', null, 'UTC')).not.toThrow()
		expect(formatCohortDateRange('not-a-date', null, 'UTC')).toEqual({
			dateString: null,
			timeString: null,
		})
	})

	it('degrades to the start-only format when only the end date is unparseable', () => {
		const { dateString } = formatCohortDateRange(
			'2026-06-01T07:01:00.000Z',
			'not-a-date',
			'UTC',
		)

		expect(dateString).toBe('June 1, 2026')
	})
})
