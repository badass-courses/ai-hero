import { describe, expect, it } from 'vitest'

import { reconcileIdentitySets } from './kit-directory-reconcile'

describe('Kit directory reconciliation', () => {
	it('builds the two missing sets and groups missing Kit ids by status', () => {
		const result = reconcileIdentitySets({
			kitStatuses: new Map([
				['kit-1', 'active'],
				['kit-2', 'cancelled'],
				['kit-3', 'active'],
			]),
			providerIdentities: [
				{ externalId: 'kit-1', contactId: 'contact-1' },
				{ externalId: 'kit-4', contactId: 'contact-2' },
				{ externalId: 'kit-5', contactId: 'contact-2' },
			],
			directoryContacts: new Set(['contact-1', 'contact-3']),
		})

		expect(result).toEqual({
			missingIdentities: ['kit-2', 'kit-3'],
			missingDirectory: ['contact-2'],
			counts: {
				kitIdentities: 3,
				providerIdentities: 3,
				directoryContacts: 2,
				missingIdentities: 2,
				missingDirectory: 1,
				missingIdentitiesByStatus: { active: 1, cancelled: 1 },
			},
		})
	})
})
