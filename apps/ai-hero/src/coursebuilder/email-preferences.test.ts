import { describe, expect, it } from 'vitest'

import { resolveUnsubscribePreference } from './email-preferences'

describe('resolveUnsubscribePreference', () => {
	it.each(['cohorts', 'cohort-004', 'ohort-004'])(
		'treats %s as cohort updates',
		(value) => {
			expect(resolveUnsubscribePreference(value)).toEqual({
				kind: 'cohort-updates',
			})
		},
	)

	it('keeps known keys', () => {
		expect(resolveUnsubscribePreference('newsletter')).toEqual({
			kind: 'known',
			key: 'newsletter',
		})
		expect(resolveUnsubscribePreference('ai-skills')).toEqual({
			kind: 'known',
			key: 'ai-skills',
		})
	})

	it('treats a missing preference as a legacy newsletter link', () => {
		expect(resolveUnsubscribePreference(undefined)).toEqual({
			kind: 'known',
			key: 'newsletter',
		})
		expect(resolveUnsubscribePreference('  ')).toEqual({
			kind: 'known',
			key: 'newsletter',
		})
	})

	it.each(['foo', 'cohort-005', 'constructor', '__proto__'])(
		'treats %s as unknown',
		(value) => {
			expect(resolveUnsubscribePreference(value)).toEqual({
				kind: 'unknown',
				raw: value,
			})
		},
	)
})
