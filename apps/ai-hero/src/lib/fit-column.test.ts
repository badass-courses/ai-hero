import { describe, expect, it } from 'vitest'

import { fitColumn, REFERRER_LENGTH } from './fit-column'

describe('fitColumn', () => {
	it('cuts an over-long referrer to the column length', () => {
		const long = `https://example.com/?q=${'x'.repeat(900)}`
		expect(fitColumn(long, REFERRER_LENGTH)).toHaveLength(REFERRER_LENGTH)
	})

	it('leaves short values and missing values alone', () => {
		expect(fitColumn('https://www.aihero.dev/', REFERRER_LENGTH)).toBe(
			'https://www.aihero.dev/',
		)
		expect(fitColumn(null, REFERRER_LENGTH)).toBeUndefined()
		expect(fitColumn(undefined, 2)).toBeUndefined()
	})
})
