import { describe, expect, it } from 'vitest'
import { buildDrovrSignupRequest } from '../lib/subscriber-marketing/drovr-doi-signup'
import { resolveRecoveryContact } from '../../scripts/held-exit-recover'
import type { ContactRecord } from '../lib/subscriber-marketing/types'

const contact: ContactRecord = {
	id: 'fixture-contact', email: 'fixture@example.test', name: 'Fixture',
	lifecycle: 'new', isProvisional: false,
	createdAt: '2026-10-06T12:00:00.000Z', updatedAt: '2026-10-06T12:00:00.000Z',
}

describe('single-contact held exit recovery', () => {
	it('resolves drovr delivery identity to the same AI Hero contact used by the executor', async () => {
		const delivered = buildDrovrSignupRequest({ contactId: contact.id,
			drovrFormId: 'fixture-form', occurredAt: contact.createdAt,
			submissionId: 'fixture-submission', page: '/fixture' })
		const find = async (id: string) => id === contact.id ? contact : undefined
		expect(await resolveRecoveryContact({ namespace: 'drovr', contactId: delivered.contactId }, find)).toEqual(contact)
		expect(await resolveRecoveryContact({ namespace: 'ai-hero', contactId: contact.id }, find)).toEqual(contact)
	})
})
