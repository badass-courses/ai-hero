import { describe, expect, it } from 'vitest'

import {
	isSyntheticPrincipalEmail,
	isSyntheticPrincipalId,
	realUserIds,
} from './synthetic-principal'

describe('synthetic principal markers', () => {
	it('recognizes only the synthetic_ id prefix', () => {
		expect(isSyntheticPrincipalId('synthetic_run-1')).toBe(true)
		expect(isSyntheticPrincipalId('contact-1')).toBe(false)
		expect(isSyntheticPrincipalId('my-synthetic_run')).toBe(false)
		expect(isSyntheticPrincipalId('')).toBe(false)
		expect(isSyntheticPrincipalId(undefined)).toBe(false)
		expect(isSyntheticPrincipalId(null)).toBe(false)
	})

	it('recognizes the reserved .invalid domain in any case, and nothing near it', () => {
		expect(isSyntheticPrincipalEmail('run-1@synthetic.aihero.invalid')).toBe(true)
		expect(isSyntheticPrincipalEmail(' Run-1@Synthetic.AIHero.Invalid ')).toBe(true)
		expect(isSyntheticPrincipalEmail('run-1@aihero.dev')).toBe(false)
		expect(isSyntheticPrincipalEmail('run-1@synthetic.aihero.invalid.example.com')).toBe(false)
		expect(isSyntheticPrincipalEmail('run-1@notsynthetic.aihero.invalid')).toBe(false)
		expect(isSyntheticPrincipalEmail(undefined)).toBe(false)
	})
})

describe('real user scope', () => {
	it('keeps survey respondents in the same scope as the user count', () => {
		expect(realUserIds(['u1', null, 'synthetic_a', undefined, 'u2'])).toEqual([
			'u1',
			'u2',
		])
	})
})
