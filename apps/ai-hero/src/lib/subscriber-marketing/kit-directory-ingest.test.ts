import { describe, expect, it, vi } from 'vitest'

import type { CaptureMarketingRepository } from './capture-contact-event'
import {
	ingestKitDirectoryBatch,
	kitDirectoryIdentityEvent,
} from './kit-directory-ingest'
import type { ContactRecord, ProviderIdentityRecord } from './types'

const contact = (id: string): ContactRecord => ({
	id,
	email: 'subscriber@example.test',
	name: 'Subscriber',
	lifecycle: 'new',
	isProvisional: true,
	createdAt: '2026-09-20T00:00:00.000Z',
	updatedAt: '2026-09-20T00:00:00.000Z',
})

function repository(args: {
	existing?: ProviderIdentityRecord
	created?: ContactRecord
}) {
	const createContact = vi.fn(
		async (
			_input?: Parameters<CaptureMarketingRepository['createContact']>[0],
			_options?: Parameters<CaptureMarketingRepository['createContact']>[1],
		) => args.created ?? contact('new-contact'),
	)
	const createProviderIdentity = vi.fn(
		async (input: Omit<ProviderIdentityRecord, 'id'>) => ({
			id: 'provider-1',
			...input,
		}),
	)
	const createContactAndProviderIdentity = vi.fn(
		async (
			input: Parameters<
				CaptureMarketingRepository['createContactAndProviderIdentity']
			>[0],
			providerIdentityInput: Parameters<
				CaptureMarketingRepository['createContactAndProviderIdentity']
			>[1],
			options?: Parameters<
				CaptureMarketingRepository['createContactAndProviderIdentity']
			>[2],
		) => {
			const createdContact = await createContact(input, options)
			const providerIdentity = await createProviderIdentity({
				...providerIdentityInput,
				contactId: createdContact.id,
			})
			return {
				contact: createdContact,
				providerIdentity,
				createdContact: true,
				createdProviderIdentity: true,
			}
		},
	)
	const findProviderIdentity = vi.fn(
		async (_provider: string, _externalId: string) => args.existing,
	)
	const fake = {
		findProviderIdentity,
		findContactById: vi.fn(async () => args.created),
		findContactByEmail: vi.fn(async () => undefined),
		createContact,
		createContactAndProviderIdentity,
		createProviderIdentity,
		linkProviderIdentityToContact: vi.fn(),
		newId: vi.fn(() => 'generated'),
	} as unknown as CaptureMarketingRepository
	return {
		fake,
		createContact,
		createContactAndProviderIdentity,
		createProviderIdentity,
		findProviderIdentity,
	}
}

describe('kit directory ingest', () => {
	it('reports existing identities and new contacts without writing in dry-run mode', async () => {
		const existing: ProviderIdentityRecord = {
			id: 'identity-1',
			contactId: 'contact-1',
			provider: 'kit',
			externalId: '42',
			evidence: {
				providerIdentity: { provider: 'kit', externalId: '42' },
				source: 'kit',
				strength: 'strong',
			},
			createdAt: '2026-09-20T00:00:00.000Z',
			updatedAt: '2026-09-20T00:00:00.000Z',
		}
		const fake = repository({ existing })
		fake.findProviderIdentity.mockImplementation(async (_, id) =>
			id === '42' ? existing : undefined,
		)
		const result = await ingestKitDirectoryBatch({
			repository: fake.fake,
			batch: [{ id: '42' }, { id: '43' }, { id: '' }],
			dryRun: true,
			now: '2026-09-20T01:00:00.000Z',
		})

		expect(result).toEqual({
			mode: 'dry-run',
			counts: {
				processed: 2,
				created: 0,
				alreadyPresent: 1,
				wouldCreate: 1,
				skippedInvalid: 1,
			},
			cursor: '43',
		})
		expect(fake.createContact).not.toHaveBeenCalled()
	})

	it('counts non-numeric Kit ids as invalid without advancing the cursor', async () => {
		const fake = repository({})
		const result = await ingestKitDirectoryBatch({
			repository: fake.fake,
			batch: [{ id: '9' }, { id: 'not-a-number' }, { id: '10' }],
			dryRun: true,
			now: '2026-09-20T01:00:00.000Z',
		})

		expect(result).toEqual({
			mode: 'dry-run',
			counts: {
				processed: 2,
				created: 0,
				alreadyPresent: 0,
				wouldCreate: 2,
				skippedInvalid: 1,
			},
			cursor: '10',
		})
	})

	it('uses the normal identity resolver to create a Kit-backed contact', async () => {
		const fake = repository({ created: contact('contact-8') })
		const result = await ingestKitDirectoryBatch({
			repository: fake.fake,
			batch: [
				{
					id: '43',
					email: 'New@Example.Test',
					name: 'New Subscriber',
					createdAt: '2026-09-19T23:00:00Z',
				},
			],
			now: '2026-09-20T01:00:00.000Z',
		})

		expect(result.counts).toEqual({
			processed: 1,
			created: 1,
			alreadyPresent: 0,
			wouldCreate: 0,
			skippedInvalid: 0,
		})
		expect(fake.createContact).toHaveBeenCalledWith(
			expect.objectContaining({
				email: 'new@example.test',
				name: 'New Subscriber',
				createdAt: '2026-09-20T01:00:00.000Z',
			}),
		{ kitSubscriberId: '43' },
		)
		expect(fake.createProviderIdentity).toHaveBeenCalledWith(
			expect.objectContaining({ provider: 'kit', externalId: '43' }),
		)
	})

	it('keeps the source subscriber id in identity evidence without storing raw payload', () => {
		const event = kitDirectoryIdentityEvent({
			subscriber: {
				id: '43',
				email: 'New@Example.Test',
				name: 'New Subscriber',
				createdAt: '2026-09-19T23:00:00Z',
			},
			now: '2026-09-20T01:00:00.000Z',
		})

		expect(event).toMatchObject({
			provider: 'kit',
			providerEventId: 'directory-import:43',
			identityEvidence: {
				email: 'new@example.test',
				providerIdentity: { provider: 'kit', externalId: '43' },
			},
			payloadSummary: { restrictedPayloadStored: false },
		})
		expect(event).not.toHaveProperty('domainPayload')
	})
})
