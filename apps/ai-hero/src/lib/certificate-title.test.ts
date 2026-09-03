import { describe, expect, it } from 'vitest'

import { certificateTitleFor } from './certificate-title'

describe('certificateTitleFor', () => {
	it('drops the cohort day prefix', () => {
		expect(certificateTitleFor('Day 9: Advanced Patterns')).toBe(
			'Advanced Patterns',
		)
		expect(certificateTitleFor('Day 2 Steering')).toBe('Steering')
	})

	it('leaves other titles alone', () => {
		expect(certificateTitleFor('AI Coding Crash Course')).toBe(
			'AI Coding Crash Course',
		)
		expect(certificateTitleFor('Daylight Patterns')).toBe('Daylight Patterns')
		expect(certificateTitleFor('Day 2.5: Advanced Patterns')).toBe(
			'Day 2.5: Advanced Patterns',
		)
		expect(certificateTitleFor(undefined)).toBe('')
	})
})
