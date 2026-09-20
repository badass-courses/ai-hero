import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
	assignNewsletterVeteransBatch,
	NEWSLETTER_VETERANS_BATCH_SIZE,
	type NewsletterVeteransRepository,
} from './newsletter-veterans'
import type {
	ContactEventRecord,
	ContactRecord,
	ProviderIdentityRecord,
} from './types'

const mocks = vi.hoisted(() => ({
	ensureShadowNewsletterOwnershipAssignment: vi.fn(),
}))

vi.mock('./skills-newsletter-path-entry', () => ({
	ensureShadowNewsletterOwnershipAssignment:
		mocks.ensureShadowNewsletterOwnershipAssignment,
}))

const contact = (id: string): ContactRecord => ({
	id,
	email: 'veteran@example.test',
	name: 'Veteran',
	lifecycle: 'new',
	isProvisional: false,
	createdAt: '2026-09-17T00:00:00.000Z',
	updatedAt: '2026-09-17T00:00:00.000Z',
})

const identity = (contactId: string, externalId: string): ProviderIdentityRecord =>
	({
		id: `identity-${externalId}`,
		contactId,
		provider: 'kit',
		externalId,
		evidence: 'provider-confirmed',
		createdAt: '2026-09-17T00:00:00.000Z',
		updatedAt: '2026-09-17T00:00:00.000Z',
	}) as unknown as ProviderIdentityRecord

const assignment = (contactId: string, journeyId: string) =>
	({
		id: `event-${contactId}-${journeyId}`,
		contactId,
		eventType: 'journey.owner.assigned',
		providerEventId: `drovr-owner:${contactId}:${journeyId}`,
	}) as unknown as ContactEventRecord

function repository(args: {
	contacts?: Record<string, ContactRecord>
	identities?: Record<string, ProviderIdentityRecord>
	assignments?: Record<string, ContactEventRecord[]>
}): NewsletterVeteransRepository {
	return {
		findContactById: vi.fn(async (id: string) => args.contacts?.[id]),
		findProviderIdentity: vi.fn(
			async (_provider: string, externalId: string) =>
				args.identities?.[externalId],
		),
		findContactEventsByType: vi.fn(
			async (contactId: string) => args.assignments?.[contactId] ?? [],
		),
		createContactEvent: vi.fn(async () => assignment('unused', 'unused')),
	} as unknown as NewsletterVeteransRepository
}

beforeEach(() => {
	vi.clearAllMocks()
})

describe('assignNewsletterVeteransBatch', () => {
	it('dry run counts what it would assign and writes nothing', async () => {
		const repo = repository({
			contacts: { c1: contact('c1') },
			identities: { k1: identity('c1', 'k1') },
		})
		const result = await assignNewsletterVeteransBatch({
			repository: repo,
			batch: [{ contactId: 'c1', kitSubscriberId: 'k1' }],
		})
		expect(result).toEqual({
			mode: 'dry-run',
			counts: {
				processed: 1,
				assigned: 0,
				wouldAssign: 1,
				alreadyAssigned: 0,
				missingContact: 0,
				identityMismatch: 0,
			},
		})
		expect(mocks.ensureShadowNewsletterOwnershipAssignment).not.toHaveBeenCalled()
	})

	it('writes the newsletter assignment with the contact and identity it verified', async () => {
		const repo = repository({
			contacts: { c1: contact('c1') },
			identities: { k1: identity('c1', 'k1') },
		})
		const result = await assignNewsletterVeteransBatch({
			repository: repo,
			batch: [{ contactId: 'c1', kitSubscriberId: 'k1' }],
			dryRun: false,
			now: '2026-09-20T17:00:00.000Z',
		})
		expect(result.mode).toBe('write')
		expect(result.counts.assigned).toBe(1)
		expect(mocks.ensureShadowNewsletterOwnershipAssignment).toHaveBeenCalledWith({
			repository: repo,
			contactId: 'c1',
			providerIdentityId: 'identity-k1',
			kitSubscriberId: 'k1',
			email: 'veteran@example.test',
			name: 'Veteran',
			occurredAt: '2026-09-20T17:00:00.000Z',
		})
	})

	it('skips contacts already assigned, missing, or whose Kit identity belongs to someone else', async () => {
		const repo = repository({
			contacts: { c1: contact('c1'), c2: contact('c2') },
			identities: { k1: identity('c1', 'k1'), k2: identity('other', 'k2') },
			assignments: { c1: [assignment('c1', 'shadow-newsletter')] },
		})
		const result = await assignNewsletterVeteransBatch({
			repository: repo,
			batch: [
				{ contactId: 'c1', kitSubscriberId: 'k1' },
				{ contactId: 'c2', kitSubscriberId: 'k2' },
				{ contactId: 'missing', kitSubscriberId: 'k3' },
			],
			dryRun: false,
		})
		expect(result.counts).toEqual({
			processed: 3,
			assigned: 0,
			wouldAssign: 0,
			alreadyAssigned: 1,
			missingContact: 1,
			identityMismatch: 1,
		})
		expect(mocks.ensureShadowNewsletterOwnershipAssignment).not.toHaveBeenCalled()
	})

	it('refuses batches above the lane-sized limit', async () => {
		const repo = repository({})
		await expect(
			assignNewsletterVeteransBatch({
				repository: repo,
				batch: Array.from(
					{ length: NEWSLETTER_VETERANS_BATCH_SIZE + 1 },
					(_, index) => ({ contactId: `c${index}`, kitSubscriberId: `k${index}` }),
				),
			}),
		).rejects.toThrow(/cannot exceed/)
	})
})
