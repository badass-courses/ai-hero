import { describe, expect, it } from 'vitest'

import { InMemorySubscriberMarketingRepository } from './dry-run'
import {
	buildPurchaseRecordedEvent,
	contactUnsubscribedSemanticKey,
	previewContactUnsubscribedContactEvents,
	previewPurchaseRecordedContactEvents,
	purchaseRecordedSemanticKey,
	writeContactUnsubscribedContactEvents,
	writePurchaseRecordedContactEvents,
	type PurchaseRecordedSource,
} from './lifecycle-contact-events'

const NOW = '2026-08-29T10:00:00.000Z'

function seedKitContact(
	repository: InMemorySubscriberMarketingRepository,
	args: { email: string; kitSubscriberId: string; userId?: string },
) {
	const contact = repository.createContact({
		userId: args.userId ?? null,
		email: args.email,
		name: 'Existing Contact',
		lifecycle: 'classified',
		isProvisional: false,
		createdAt: NOW,
		updatedAt: NOW,
	})
	repository.createProviderIdentity({
		contactId: contact.id,
		provider: 'kit',
		externalId: args.kitSubscriberId,
		evidence: {
			email: args.email,
			providerIdentity: { provider: 'kit', externalId: args.kitSubscriberId },
			source: 'kit',
			strength: 'strong',
		},
		createdAt: NOW,
		updatedAt: NOW,
	})
	return contact
}

function purchaseSource(
	overrides: Partial<PurchaseRecordedSource> = {},
): PurchaseRecordedSource {
	return {
		purchaseId: 'purchase-1',
		userId: 'user-1',
		email: 'buyer@example.com',
		name: 'Buyer One',
		productId: 'product-aicc',
		status: 'Valid',
		totalAmount: '199',
		purchasedAt: '2026-08-18T12:34:56.000Z',
		...overrides,
	}
}

describe('purchase.recorded lifecycle contact events', () => {
	it('writes a purchase.recorded event onto an existing contact found by email', async () => {
		const repository = new InMemorySubscriberMarketingRepository()
		const contact = seedKitContact(repository, {
			email: 'buyer@example.com',
			kitSubscriberId: 'kit-123',
		})

		const summary = await writePurchaseRecordedContactEvents({
			repository,
			rows: [purchaseSource()],
			now: NOW,
		})

		expect(summary.counts).toMatchObject({
			rows: 1,
			eligible: 1,
			written: 1,
			skipped: 0,
			createdProviderIdentities: 1,
		})
		const event = summary.written[0]!
		expect(event.contactId).toBe(contact.id)
		expect(event.eventType).toBe('purchase.recorded')
		expect(event.provider).toBe('ai-hero')
		expect(event.occurredAt).toBe('2026-08-18T12:34:56.000Z')
		expect(event.semanticIdempotencyKey).toBe(
			'ai-hero:purchase.recorded:purchase:purchase-1',
		)
		// The new ai-hero identity is keyed by userId so later purchases by the
		// same user resolve directly.
		const identity = repository.findProviderIdentity('ai-hero', 'user-1')
		expect(identity?.contactId).toBe(contact.id)
	})

	it('never touches contact state, next actions, or side-effect intents', async () => {
		const repository = new InMemorySubscriberMarketingRepository()
		seedKitContact(repository, {
			email: 'buyer@example.com',
			kitSubscriberId: 'kit-123',
		})

		await writePurchaseRecordedContactEvents({
			repository,
			rows: [purchaseSource()],
			now: NOW,
		})

		expect(repository.states.size).toBe(0)
		expect(repository.transitions.size).toBe(0)
		expect(repository.nextActions.size).toBe(0)
		expect(repository.sideEffectIntents.size).toBe(0)
	})

	it('is idempotent on the semantic key across repeated writes', async () => {
		const repository = new InMemorySubscriberMarketingRepository()
		seedKitContact(repository, {
			email: 'buyer@example.com',
			kitSubscriberId: 'kit-123',
		})

		const first = await writePurchaseRecordedContactEvents({
			repository,
			rows: [purchaseSource()],
			now: NOW,
		})
		const second = await writePurchaseRecordedContactEvents({
			repository,
			rows: [purchaseSource()],
			now: NOW,
		})

		expect(first.counts.written).toBe(1)
		expect(second.counts.written).toBe(0)
		expect(second.counts.skippedByReason['duplicate-semantic-key']).toBe(1)
		expect(repository.contactEvents.size).toBe(1)
	})

	it('resolves directly through an existing ai-hero userId identity', async () => {
		const repository = new InMemorySubscriberMarketingRepository()
		const contact = repository.createContact({
			userId: 'user-1',
			email: 'buyer@example.com',
			name: null,
			lifecycle: 'customer',
			isProvisional: false,
			createdAt: NOW,
			updatedAt: NOW,
		})
		repository.createProviderIdentity({
			contactId: contact.id,
			provider: 'ai-hero',
			externalId: 'user-1',
			evidence: {
				userId: 'user-1',
				providerIdentity: { provider: 'ai-hero', externalId: 'user-1' },
				source: 'ai-hero',
				strength: 'strong',
			},
			createdAt: NOW,
			updatedAt: NOW,
		})

		const summary = await writePurchaseRecordedContactEvents({
			repository,
			rows: [purchaseSource()],
			now: NOW,
		})

		expect(summary.counts.written).toBe(1)
		expect(summary.counts.createdProviderIdentities).toBe(0)
		const decision = summary.decisions[0]!
		expect(decision.status).toBe('eligible')
		if (decision.status === 'eligible') {
			expect(decision.identityResolutionPath).toBe(
				'user-id-existing-ai-hero-provider-identity',
			)
		}
	})

	it('skips purchasers with no existing contact instead of creating one', async () => {
		const repository = new InMemorySubscriberMarketingRepository()

		const summary = await writePurchaseRecordedContactEvents({
			repository,
			rows: [purchaseSource({ email: 'stranger@example.com' })],
			now: NOW,
		})

		expect(summary.counts.written).toBe(0)
		expect(summary.counts.skippedByReason['no-existing-contact']).toBe(1)
		expect(repository.contacts.size).toBe(0)
		expect(repository.contactEvents.size).toBe(0)
	})

	it('produces the same semantic key from forward capture and backfill shapes', () => {
		const evidence = {
			source: 'ai-hero' as const,
			strength: 'strong' as const,
			providerIdentity: { provider: 'ai-hero' as const, externalId: 'user-1' },
		}
		const forward = buildPurchaseRecordedEvent(purchaseSource(), evidence)
		const backfill = buildPurchaseRecordedEvent(
			purchaseSource({ email: null, name: null }),
			evidence,
		)
		expect(forward.semanticIdempotencyKey).toBe(
			backfill.semanticIdempotencyKey,
		)
		expect(forward.semanticIdempotencyKey).toBe(
			purchaseRecordedSemanticKey('purchase-1'),
		)
	})

	it('preview reports eligibility without writing anything', async () => {
		const repository = new InMemorySubscriberMarketingRepository()
		seedKitContact(repository, {
			email: 'buyer@example.com',
			kitSubscriberId: 'kit-123',
		})
		const identitiesBefore = repository.providerIdentities.size

		const summary = await previewPurchaseRecordedContactEvents({
			repository,
			rows: [purchaseSource()],
		})

		expect(summary.mode).toBe('preview')
		expect(summary.counts.eligible).toBe(1)
		expect(summary.counts.written).toBe(0)
		const decision = summary.decisions[0]!
		if (decision.status === 'eligible') {
			expect(decision.wouldCreateProviderIdentity).toBe(true)
		}
		expect(repository.contactEvents.size).toBe(0)
		expect(repository.providerIdentities.size).toBe(identitiesBefore)
	})
})

describe('contact.unsubscribed lifecycle contact events', () => {
	it('writes onto the contact behind the kit subscriber identity', async () => {
		const repository = new InMemorySubscriberMarketingRepository()
		const contact = seedKitContact(repository, {
			email: 'reader@example.com',
			kitSubscriberId: 'kit-777',
		})

		const summary = await writeContactUnsubscribedContactEvents({
			repository,
			rows: [
				{
					email: 'Reader@Example.com',
					kitSubscriberId: 'kit-777',
					preferenceKey: 'newsletter',
					source: 'preferences-page',
					occurredAt: NOW,
				},
			],
			now: NOW,
		})

		expect(summary.counts.written).toBe(1)
		const event = summary.written[0]!
		expect(event.contactId).toBe(contact.id)
		expect(event.eventType).toBe('contact.unsubscribed')
		expect(event.provider).toBe('kit')
		expect(event.semanticIdempotencyKey).toBe(
			contactUnsubscribedSemanticKey('reader@example.com', 'newsletter'),
		)
		expect(repository.states.size).toBe(0)
		expect(repository.sideEffectIntents.size).toBe(0)
	})

	it('dedupes the same opt-out arriving from different sources', async () => {
		const repository = new InMemorySubscriberMarketingRepository()
		seedKitContact(repository, {
			email: 'reader@example.com',
			kitSubscriberId: 'kit-777',
		})

		const first = await writeContactUnsubscribedContactEvents({
			repository,
			rows: [
				{
					email: 'reader@example.com',
					kitSubscriberId: 'kit-777',
					preferenceKey: 'newsletter',
					source: 'unsubscribe-link',
					occurredAt: NOW,
				},
			],
			now: NOW,
		})
		// The backfill sees the same opt-out via the local mirror, without the
		// kit subscriber id.
		const second = await writeContactUnsubscribedContactEvents({
			repository,
			rows: [
				{
					email: 'reader@example.com',
					preferenceKey: 'newsletter',
					source: 'backfill-communication-preferences',
					occurredAt: '2026-08-01T00:00:00.000Z',
				},
			],
			now: NOW,
		})

		expect(first.counts.written).toBe(1)
		expect(second.counts.written).toBe(0)
		expect(second.counts.skippedByReason['duplicate-semantic-key']).toBe(1)
		expect(repository.contactEvents.size).toBe(1)
	})

	it('tracks separate preference keys as separate events', async () => {
		const repository = new InMemorySubscriberMarketingRepository()
		seedKitContact(repository, {
			email: 'reader@example.com',
			kitSubscriberId: 'kit-777',
		})

		const summary = await writeContactUnsubscribedContactEvents({
			repository,
			rows: [
				{
					email: 'reader@example.com',
					kitSubscriberId: 'kit-777',
					preferenceKey: 'newsletter',
					source: 'preferences-page',
					occurredAt: NOW,
				},
				{
					email: 'reader@example.com',
					kitSubscriberId: 'kit-777',
					preferenceKey: 'ai-skills',
					source: 'preferences-page',
					occurredAt: NOW,
				},
			],
			now: NOW,
		})

		expect(summary.counts.written).toBe(2)
	})

	it('skips opt-outs for emails with no existing contact', async () => {
		const repository = new InMemorySubscriberMarketingRepository()

		const summary = await previewContactUnsubscribedContactEvents({
			repository,
			rows: [
				{
					email: 'ghost@example.com',
					preferenceKey: 'newsletter',
					source: 'preferences-page',
					occurredAt: NOW,
				},
			],
		})

		expect(summary.counts.eligible).toBe(0)
		expect(summary.counts.skippedByReason['no-existing-contact']).toBe(1)
	})
})
