import { describe, expect, it, vi } from 'vitest'
const requestProfileSync = vi.hoisted(() => vi.fn())
vi.mock('./drovr-contact-profile-sync-requests', () => ({
	requestContactProfileSyncSafely: requestProfileSync,
}))
import { InMemorySubscriberMarketingRepository } from './dry-run'
import {
	ensureBuyerContact,
	writePurchaseRecordedContactEvents,
} from './lifecycle-contact-events'
import { recordBuyerEntitlement } from './buyer-entitlement'
import { mapDrovrShadowFact } from './drovr-shadow-emitter'

const now = '2026-11-02T12:00:00.000Z'
const buyer = {
	userId: 'holder-1',
	email: 'holder@example.test',
	name: 'Holder',
}

describe('buyer Contact birth and ownership', () => {
	it('creates a provisional Contact and stable identity, then records a previously skipped purchase', async () => {
		const repository = new InMemorySubscriberMarketingRepository()
		const first = await ensureBuyerContact({ repository, buyer, now })
		const second = await ensureBuyerContact({ repository, buyer, now })
		expect(second?.id).toBe(first?.id)
		expect(first).toMatchObject({
			email: buyer.email,
			userId: buyer.userId,
			lifecycle: 'new',
			isProvisional: true,
		})
		expect(first?.optInAttribution).toBeFalsy()
		const source = {
			...buyer,
			purchaseId: 'purchase-1',
			productId: 'course-1',
			status: 'Valid',
			totalAmount: '199',
			purchasedAt: now,
		}
		const result = await writePurchaseRecordedContactEvents({
			repository,
			rows: [source],
			now,
		})
		expect(result.counts.written).toBe(1)
		expect(result.written[0]?.contactId).toBe(first?.id)
		expect(
			(
				await writePurchaseRecordedContactEvents({
					repository,
					rows: [source],
					now,
				})
			).counts.written,
		).toBe(0)
	})

	it('reuses an existing Contact by email without creating a second one', async () => {
		const repository = new InMemorySubscriberMarketingRepository()
		const existing = repository.createContact({
			userId: null,
			email: buyer.email,
			name: null,
			lifecycle: 'classified',
			isProvisional: false,
			createdAt: now,
			updatedAt: now,
		})
		expect((await ensureBuyerContact({ repository, buyer, now }))?.id).toBe(
			existing.id,
		)
	})

	it('does not create anonymous contacts', async () => {
		const repository = new InMemorySubscriberMarketingRepository()
		expect(
			await ensureBuyerContact({ repository, buyer: {}, now }),
		).toBeUndefined()
	})

	it.each(['purchase-transfer:transfer-1', 'team-seat:purchase-1'])(
		'records %s on the receiving user, dedupes replay, and sends no email on facts',
		async (entitlementId) => {
			requestProfileSync.mockClear()
			const redispatchContactEvent = vi.fn()
			const repository = Object.assign(
				new InMemorySubscriberMarketingRepository(),
				{ redispatchContactEvent },
			)
			const source = {
				...buyer,
				change: 'granted' as const,
				entitlementId,
				productId: 'course-1',
				viaProductId: 'course-1',
				bundlePolicy: 'ownership',
				occurredAt: now,
			}
			const result = await recordBuyerEntitlement({ repository, source })
			expect(result.counts.written).toBe(1)
			const event = result.written[0]!
			expect(requestProfileSync).toHaveBeenCalledWith(
				{ contactId: event.contactId, reason: 'reconcile' },
				{ eventId: `buyer-profile:${event.id}` },
			)
			expect(event.contactId).toBe(
				repository.findProviderIdentity('ai-hero', buyer.userId)?.contactId,
			)
			expect(event.semanticIdempotencyKey).toBe(
				`ai-hero:entitlement.granted:${entitlementId}`,
			)
			const wire = mapDrovrShadowFact({ kind: 'contact-event', event })
			expect(
				wire.some(
					(fact) =>
						fact.type === 'entitlement.granted' &&
						fact.payload &&
						'productId' in fact.payload &&
						fact.payload.productId === 'course-1',
				),
			).toBe(true)
			expect(JSON.stringify(wire)).not.toContain(buyer.email)
			expect(
				(await recordBuyerEntitlement({ repository, source })).counts.written,
			).toBe(0)
			expect(redispatchContactEvent).toHaveBeenCalledTimes(1)
			expect(redispatchContactEvent).toHaveBeenCalledWith(event)
			expect(requestProfileSync).toHaveBeenCalledTimes(2)
			expect(requestProfileSync.mock.calls[1]).toEqual(
				requestProfileSync.mock.calls[0],
			)
		},
	)
})
