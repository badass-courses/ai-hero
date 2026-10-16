import { describe, expect, it } from 'vitest'

import { organizationIdsToCheck } from './hero-access-organizations'

describe('organizationIdsToCheck', () => {
	it('falls back to memberships when no organization is named', () => {
		expect(organizationIdsToCheck(null, ['org-a'])).toEqual(['org-a'])
	})
	it('checks the named organization first, then the rest, without repeats', () => {
		expect(
			organizationIdsToCheck('org-b', ['org-a', 'org-b', 'org-c']),
		).toEqual(['org-b', 'org-a', 'org-c'])
	})
	it('keeps a named org the viewer has no membership in', () => {
		expect(organizationIdsToCheck('org-x', [])).toEqual(['org-x'])
	})
	it('drops empty and null ids', () => {
		expect(organizationIdsToCheck('', [null, undefined, 'org-a'])).toEqual([
			'org-a',
		])
	})
	it('returns nothing when there is nothing to check', () => {
		expect(organizationIdsToCheck(null, [])).toEqual([])
	})
})
