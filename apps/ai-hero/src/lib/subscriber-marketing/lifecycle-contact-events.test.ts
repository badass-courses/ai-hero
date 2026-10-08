import { describe, expect, it } from 'vitest'

import {
	EMAIL_COURSE_ENTRY_PAYLOAD_FORMAT,
	deadlineTimeZoneEvidenceFromHeader,
} from './course-sequence-exhaustion'
import { InMemorySubscriberMarketingRepository } from './dry-run'
import {
	DROVR_EVERGREEN_OFFER_JOURNEY_ID,
	mapDrovrShadowFact,
} from './drovr-shadow-emitter'
import {
	buildPurchaseRecordedEvent,
	contactUnsubscribedSemanticKey,
	previewContactUnsubscribedContactEvents,
	previewPurchaseRecordedContactEvents,
	purchaseRecordedBuyerSemanticKey,
	purchaseRecordedSemanticKey,
	writeContactUnsubscribedContactEvents,
	writePurchaseRecordedContactEvents,
	type PurchaseRecordedSource,
} from './lifecycle-contact-events'
import type { ContactEventRecord } from './types'

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

	it('preserves the course entry timezone on the purchase event', async () => {
		const repository = new InMemorySubscriberMarketingRepository()
		const contact = seedKitContact(repository, {
			email: 'buyer@example.com',
			kitSubscriberId: 'kit-123',
		})
		const deadline = deadlineTimeZoneEvidenceFromHeader({
			headerValue: 'Asia/Tokyo',
			capturedAt: '2026-08-17T12:00:00.000Z',
		})
		if (!deadline.ok) throw new Error(deadline.error.detail)
		const identity = repository.findProviderIdentity('kit', 'kit-123')
		if (!identity) throw new Error('missing test identity')
		repository.createEmailCourseEntryEvent({
			contactId: contact.id,
			providerIdentityId: identity.id,
			provider: 'kit',
			providerEventId: 'entry-1',
			providerReference: 'entry-1',
			eventType: 'value-path.entered',
			occurredAt: '2026-08-17T12:00:00.000Z',
			semanticIdempotencyKey: 'entry-1',
			privacyLevel: 'internal',
			identityEvidence: identity.evidence,
			payloadSummary: {
				summary: 'course entry',
				keywords: [],
				restrictedPayloadStored: false,
			},
			payloadFormat: EMAIL_COURSE_ENTRY_PAYLOAD_FORMAT,
			domainPayload: {
				format: EMAIL_COURSE_ENTRY_PAYLOAD_FORMAT,
				valuePathId: 'ai-hero-skills-workflow',
				emailResourceId: 'ai-hero-skills-workflow.email-0',
				deadlineTimeZone: deadline.value,
			},
			schemaVersion: 1,
		})

		const summary = await writePurchaseRecordedContactEvents({
			repository,
			rows: [purchaseSource()],
			now: NOW,
		})

		expect(summary.written[0]?.domainPayload).toEqual({
			deadlineTimeZone: deadline.value,
		})
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

/**
 * Row 194 (09-24 coupon cohort): five buyers redeemed their evergreen
 * coupon and were still sent "Final notice… ends tonight". The purchase was
 * resolved through the buyer's user, never the coupon: twice to no contact
 * at all (skipped), twice to another contact with no evergreen actor, and
 * once to the right contact but never delivered (the dispatch pin lives in
 * drizzle-capture-repository-birth-dispatch.test.ts).
 */
class DyingDispatchRepository extends InMemorySubscriberMarketingRepository {
	dieAfterInsert = true
	redispatched: ContactEventRecord[] = []

	createContactEvent(
		input: Parameters<
			InMemorySubscriberMarketingRepository['createContactEvent']
		>[0],
	) {
		const event = super.createContactEvent(input)
		if (this.dieAfterInsert) throw new Error('lambda died before the dispatch')
		return event
	}

	findContactEventBySemanticKey(key: string) {
		const found = super.findContactEventBySemanticKey(key)
		if (!found) return found
		const { domainPayload: _notStored, ...stored } = found
		return stored
	}

	redispatchContactEvent(record: ContactEventRecord) {
		this.redispatched.push(record)
	}
}

describe('evergreen coupon purchases (row 194)', () => {
	const COUPON_ID = `eoj-coupon:${'c'.repeat(64)}`

	function seedUserContact(
		repository: InMemorySubscriberMarketingRepository,
		args: { email: string; userId: string },
	) {
		const contact = repository.createContact({
			userId: args.userId,
			email: args.email,
			name: null,
			lifecycle: 'classified',
			isProvisional: false,
			createdAt: NOW,
			updatedAt: NOW,
		})
		repository.createProviderIdentity({
			contactId: contact.id,
			provider: 'ai-hero',
			externalId: args.userId,
			evidence: {
				userId: args.userId,
				providerIdentity: { provider: 'ai-hero', externalId: args.userId },
				source: 'ai-hero',
				strength: 'strong',
			},
			createdAt: NOW,
			updatedAt: NOW,
		})
		return contact
	}

	function seedOfferContact(repository: InMemorySubscriberMarketingRepository) {
		return seedKitContact(repository, {
			email: 'course-signup@example.com',
			kitSubscriberId: 'kit-offer',
		})
	}

	function eventsFor(
		repository: InMemorySubscriberMarketingRepository,
		contactId: string,
	) {
		return Array.from(repository.contactEvents.values()).filter(
			(event) => event.contactId === contactId,
		)
	}

	it.each([
		['a user with no contact', { userId: 'user-new', email: 'new@example.com' }],
		['an unknown email and no user', { userId: null, email: 'new@example.com' }],
	])(
		'records the purchase on the coupon contact when the buyer is %s (was skipped)',
		async (_label, buyer) => {
			const repository = new InMemorySubscriberMarketingRepository()
			const offerContact = seedOfferContact(repository)

			const summary = await writePurchaseRecordedContactEvents({
				repository,
				rows: [
					purchaseSource({
						...buyer,
						productId: 'product-ma254',
						evergreenOffer: { couponId: COUPON_ID, contactId: offerContact.id },
					}),
				],
				now: NOW,
			})

			expect(summary.counts).toMatchObject({ written: 1, skipped: 0 })
			const decision = summary.decisions[0]!
			expect(decision).toMatchObject({
				status: 'eligible',
				contactId: offerContact.id,
				identityResolutionPath: 'evergreen-coupon-issue-contact',
			})
			const [event] = eventsFor(repository, offerContact.id)
			expect(event).toMatchObject({
				eventType: 'purchase.recorded',
				semanticIdempotencyKey: purchaseRecordedSemanticKey('purchase-1'),
				domainPayload: {
					evergreenOffer: { couponId: COUPON_ID, sameOffer: true },
				},
			})
			// The buyer's user is not linked to the offer contact on the coupon's say-so.
			expect(repository.contacts.size).toBe(1)
			expect(
				await repository.findProviderIdentity('ai-hero', 'user-new'),
			).toBeUndefined()
		},
	)

	it('records it on the coupon contact AND on the buyer contact when they differ (was folded onto the buyer contact only)', async () => {
		const repository = new InMemorySubscriberMarketingRepository()
		const offerContact = seedOfferContact(repository)
		const buyerContact = seedUserContact(repository, {
			email: 'buyer@example.com',
			userId: 'user-1',
		})

		const summary = await writePurchaseRecordedContactEvents({
			repository,
			rows: [
				purchaseSource({
					productId: 'product-ma254',
					evergreenOffer: { couponId: COUPON_ID, contactId: offerContact.id },
				}),
			],
			now: NOW,
		})

		expect(summary.counts.written).toBe(2)
		const [offerEvent] = eventsFor(repository, offerContact.id)
		const [buyerEvent] = eventsFor(repository, buyerContact.id)
		expect(offerEvent).toMatchObject({
			semanticIdempotencyKey: purchaseRecordedSemanticKey('purchase-1'),
			domainPayload: {
				evergreenOffer: { couponId: COUPON_ID, sameOffer: true },
			},
		})
		// The buyer's own contact still hears it, so any pitch there stops too,
		// but it is not the offer that converted.
		expect(buyerEvent).toMatchObject({
			eventType: 'purchase.recorded',
			semanticIdempotencyKey: purchaseRecordedBuyerSemanticKey('purchase-1'),
			providerEventId: 'purchase:purchase-1:buyer',
			payloadSummary: {
				keywords: ['purchase-recorded', 'product-ma254', 'status-valid'],
			},
		})
		expect(buyerEvent?.domainPayload).toBeUndefined()
		// Literal keys: ContactEvent_semanticIdempotencyKey_uq would swallow a
		// buyer copy that reused the offer record's key (the in-memory
		// repository enforces it too).
		expect(offerEvent?.semanticIdempotencyKey).toBe(
			'ai-hero:purchase.recorded:purchase:purchase-1',
		)
		expect(buyerEvent?.semanticIdempotencyKey).toBe(
			'ai-hero:purchase.recorded:purchase:purchase-1:buyer',
		)

		const again = await writePurchaseRecordedContactEvents({
			repository,
			rows: [
				purchaseSource({
					productId: 'product-ma254',
					evergreenOffer: { couponId: COUPON_ID, contactId: offerContact.id },
				}),
			],
			now: NOW,
		})
		expect(again.counts).toMatchObject({
			written: 0,
			skippedByReason: { 'duplicate-semantic-key': 2 },
		})
	})

	// A pre-fix purchase replayed after deploy (a manual re-send past the
	// function's idempotency window): its unsuffixed record already sits on
	// the buyer's contact. Nothing is written, and the offer contact is not
	// repaired: no replay fixes the five, by design.
	it('writes nothing when a pre-fix purchase is replayed', async () => {
		const repository = new InMemorySubscriberMarketingRepository()
		const offerContact = seedOfferContact(repository)
		const buyerContact = seedUserContact(repository, {
			email: 'buyer@example.com',
			userId: 'user-1',
		})
		await writePurchaseRecordedContactEvents({
			repository,
			rows: [purchaseSource({ productId: 'product-ma254' })],
			now: NOW,
		})
		expect(eventsFor(repository, buyerContact.id)).toHaveLength(1)

		const replay = await writePurchaseRecordedContactEvents({
			repository,
			rows: [
				purchaseSource({
					productId: 'product-ma254',
					evergreenOffer: { couponId: COUPON_ID, contactId: offerContact.id },
				}),
			],
			now: NOW,
		})

		expect(replay.counts).toMatchObject({
			written: 0,
			skippedByReason: { 'duplicate-semantic-key': 2 },
		})
		expect(eventsFor(repository, buyerContact.id)).toHaveLength(1)
		expect(eventsFor(repository, offerContact.id)).toHaveLength(0)
	})

	it('records it once when the buyer is the coupon contact', async () => {
		const repository = new InMemorySubscriberMarketingRepository()
		const contact = seedUserContact(repository, {
			email: 'buyer@example.com',
			userId: 'user-1',
		})

		const summary = await writePurchaseRecordedContactEvents({
			repository,
			rows: [
				purchaseSource({
					productId: 'product-ma254',
					evergreenOffer: { couponId: COUPON_ID, contactId: contact.id },
				}),
			],
			now: NOW,
		})

		expect(summary.counts.written).toBe(1)
		expect(summary.counts.createdProviderIdentities).toBe(0)
		expect(eventsFor(repository, contact.id)).toEqual([
			expect.objectContaining({
				semanticIdempotencyKey: purchaseRecordedSemanticKey('purchase-1'),
				domainPayload: {
					evergreenOffer: { couponId: COUPON_ID, sameOffer: true },
				},
			}),
		])
	})

	it('falls back to the buyer when the coupon contact no longer exists', async () => {
		const repository = new InMemorySubscriberMarketingRepository()
		const buyerContact = seedUserContact(repository, {
			email: 'buyer@example.com',
			userId: 'user-1',
		})

		const summary = await writePurchaseRecordedContactEvents({
			repository,
			rows: [
				purchaseSource({
					evergreenOffer: { couponId: COUPON_ID, contactId: 'gone' },
				}),
			],
			now: NOW,
		})

		expect(summary.counts.written).toBe(1)
		const [event] = eventsFor(repository, buyerContact.id)
		expect(event).toMatchObject({
			semanticIdempotencyKey: purchaseRecordedSemanticKey('purchase-1'),
		})
		expect(event?.domainPayload).toBeUndefined()
	})

	it('keeps the buyer path unchanged for a purchase without an evergreen coupon', async () => {
		const repository = new InMemorySubscriberMarketingRepository()
		seedOfferContact(repository)
		const buyerContact = seedUserContact(repository, {
			email: 'buyer@example.com',
			userId: 'user-1',
		})

		const summary = await writePurchaseRecordedContactEvents({
			repository,
			rows: [purchaseSource({ productId: 'product-ma254' })],
			now: NOW,
		})

		expect(summary.counts.written).toBe(1)
		expect(summary.decisions[0]).toMatchObject({
			contactId: buyerContact.id,
			identityResolutionPath: 'user-id-existing-ai-hero-provider-identity',
		})
		expect(eventsFor(repository, buyerContact.id)[0]?.domainPayload).toBeUndefined()
	})

	describe('a purchase.recorded whose drovr dispatch died (row 194b)', () => {
		const dyingRepository = () => {
			const repository = new DyingDispatchRepository()
			seedKitContact(repository, {
				email: 'buyer@example.com',
				kitSubscriberId: 'kit-123',
			})
			return repository
		}

		it('re-dispatches the record the insert left behind when the step retries, and writes nothing new', async () => {
			const repository = dyingRepository()
			await expect(
				writePurchaseRecordedContactEvents({
					repository,
					rows: [purchaseSource()],
					now: NOW,
					redispatchDuplicates: true,
				}),
			).rejects.toThrow('lambda died before the dispatch')
			expect(repository.redispatched).toEqual([])
			const [inserted] = [...repository.contactEvents.values()]
			repository.dieAfterInsert = false

			const retry = await writePurchaseRecordedContactEvents({
				repository,
				rows: [purchaseSource()],
				now: NOW,
				redispatchDuplicates: true,
			})

			expect(retry.counts.written).toBe(0)
			expect(repository.contactEvents.size).toBe(1)
			expect(repository.redispatched).toEqual([inserted])
			expect(inserted?.semanticIdempotencyKey).toBe(
				purchaseRecordedSemanticKey('purchase-1'),
			)
		})

		it('re-sends the evergreen coupon evidence and the same drovr keys as the first attempt, though the row read back from MySQL has no domainPayload', async () => {
		const repository = new DyingDispatchRepository()
		const offerContact = seedOfferContact(repository)
		seedUserContact(repository, {
			email: 'buyer@example.com',
			userId: 'user-1',
		})
		const row = purchaseSource({
			productId: 'product-ma254',
			evergreenOffer: { couponId: COUPON_ID, contactId: offerContact.id },
		})
		await expect(
			writePurchaseRecordedContactEvents({
				repository,
				rows: [row],
				now: NOW,
				redispatchDuplicates: true,
			}),
		).rejects.toThrow('lambda died before the dispatch')
		const [inserted] = [...repository.contactEvents.values()]
		if (!inserted) throw new Error('the insert left no record')
		expect(inserted.domainPayload).toMatchObject({
			evergreenOffer: { couponId: COUPON_ID, sameOffer: true },
		})
		repository.dieAfterInsert = false

		await writePurchaseRecordedContactEvents({
			repository,
			rows: [row],
			now: NOW,
			redispatchDuplicates: true,
		})

		const [resent] = repository.redispatched
		if (!resent) throw new Error('nothing was re-dispatched')
		const firstAttempt = mapDrovrShadowFact({
			kind: 'contact-event',
			event: inserted,
		})
		const secondAttempt = mapDrovrShadowFact({
			kind: 'contact-event',
			event: resent,
		})
		expect(
			secondAttempt.find(
				(event) => event.journeyId === DROVR_EVERGREEN_OFFER_JOURNEY_ID,
			)?.payload,
		).toEqual({
			productId: 'product-ma254',
			couponId: COUPON_ID,
			sameOffer: true,
		})
		expect(secondAttempt).toEqual(firstAttempt)
		expect(secondAttempt.map((event) => event.idempotencyKey)).toEqual(
			firstAttempt.map((event) => event.idempotencyKey),
		)
	})

	it('re-dispatches nothing when the flag is off, as a backfill runs', async () => {
			const repository = dyingRepository()
			repository.dieAfterInsert = false
			await writePurchaseRecordedContactEvents({
				repository,
				rows: [purchaseSource()],
				now: NOW,
			})

			await writePurchaseRecordedContactEvents({
				repository,
				rows: [purchaseSource()],
				now: NOW,
			})

			expect(repository.redispatched).toEqual([])
		})

		it('re-dispatches each record of an evergreen coupon purchase once: the offer contact and the buyer copy', async () => {
			const repository = new DyingDispatchRepository()
			repository.dieAfterInsert = false
			const offerContact = seedOfferContact(repository)
			seedUserContact(repository, {
				email: 'buyer@example.com',
				userId: 'user-1',
			})
			const row = purchaseSource({
				productId: 'product-ma254',
				evergreenOffer: { couponId: COUPON_ID, contactId: offerContact.id },
			})
			await writePurchaseRecordedContactEvents({
				repository,
				rows: [row],
				now: NOW,
			})

			await writePurchaseRecordedContactEvents({
				repository,
				rows: [row],
				now: NOW,
				redispatchDuplicates: true,
			})

			expect(
				repository.redispatched
				.map((event) => event.semanticIdempotencyKey)
				.sort(),
			).toEqual([
				purchaseRecordedSemanticKey('purchase-1'),
				purchaseRecordedBuyerSemanticKey('purchase-1'),
			])
		})

		it('re-dispatches nothing for a pre-fix record that sits on the buyer contact while the purchase now targets the offer contact', async () => {
			const repository = new DyingDispatchRepository()
			repository.dieAfterInsert = false
			const offerContact = seedOfferContact(repository)
			seedUserContact(repository, {
				email: 'buyer@example.com',
				userId: 'user-1',
			})
			await writePurchaseRecordedContactEvents({
				repository,
				rows: [purchaseSource({ productId: 'product-ma254' })],
				now: NOW,
			})

			await writePurchaseRecordedContactEvents({
				repository,
				rows: [
					purchaseSource({
						productId: 'product-ma254',
						evergreenOffer: { couponId: COUPON_ID, contactId: offerContact.id },
					}),
				],
				now: NOW,
				redispatchDuplicates: true,
			})

			expect(repository.redispatched).toEqual([])
		})
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

	it('dedupes a tag action durably but records a later tag opt-out again', async () => {
		const repository = new InMemorySubscriberMarketingRepository()
		seedKitContact(repository, { email: 'reader@example.com', kitSubscriberId: 'kit-777' })
		const row = { email: 'reader@example.com', kitSubscriberId: 'kit-777', preferenceKey: 'newsletter', source: 'kit-webhook:subscriber.tag_added', occurredAt: NOW, idempotencyKey: `kit-webhook:tag:8244351:kit-777:${NOW}:newsletter` }
		const first = await writeContactUnsubscribedContactEvents({ repository, rows: [row], now: NOW })
		const duplicate = await writeContactUnsubscribedContactEvents({ repository, rows: [row], now: NOW })
		const later = await writeContactUnsubscribedContactEvents({ repository, rows: [{ ...row, occurredAt: '2026-10-08T00:00:00Z', idempotencyKey: 'kit-webhook:tag:8244351:kit-777:2026-10-08T00:00:00.000Z:newsletter' }], now: NOW })
		expect(first.counts.written).toBe(1)
		expect(first.written[0]?.semanticIdempotencyKey).toBe(row.idempotencyKey)
		expect(duplicate.counts.written).toBe(0)
		expect(duplicate.counts.skippedByReason['duplicate-semantic-key']).toBe(1)
		expect(later.counts.written).toBe(1)
		expect(repository.contactEvents.size).toBe(2)
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
