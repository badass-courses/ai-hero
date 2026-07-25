import { describe, expect, it } from 'vitest'

import { gradeAnswer } from './grade-answer'

describe('gradeAnswer', () => {
	it('grades a single answer', () => {
		expect(gradeAnswer('b', 'b')).toBe(true)
		expect(gradeAnswer('b', 'a')).toBe(false)
	})

	it('accepts an exact multi-select match', () => {
		expect(gradeAnswer(['a', 'c'], ['a', 'c'])).toBe(true)
	})

	it('rejects a proper subset', () => {
		expect(gradeAnswer(['a', 'b', 'c'], ['a', 'c'])).toBe(false)
	})

	it('rejects a superset', () => {
		expect(gradeAnswer(['a', 'c'], ['a', 'b', 'c'])).toBe(false)
	})

	it('ignores answer order', () => {
		expect(gradeAnswer(['a', 'c'], ['c', 'a'])).toBe(true)
	})

	it('only accepts an empty answer when the correct set is empty', () => {
		expect(gradeAnswer(['a'], [])).toBe(false)
		expect(gradeAnswer([], [])).toBe(true)
	})
})
