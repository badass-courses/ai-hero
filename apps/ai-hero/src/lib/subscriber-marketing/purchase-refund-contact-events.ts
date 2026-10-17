import type { ContactEventWriteRepository } from './contact-event-normalizer-preview'
import {
	purchaseRecordedBuyerSemanticKey,
	purchaseRecordedSemanticKey,
} from './lifecycle-contact-events'
import { purchaseRefundFacts } from './purchase-facts'
import { CONTACT_EVENT_SCHEMA_VERSION } from './types'

export async function writePurchaseRefundContactEvents(args: {
	repository: ContactEventWriteRepository
	purchaseId: string
	refunds: readonly unknown[]
	now?: string
}) {
	const { repository, purchaseId } = args
	const primary = await repository.findContactEventBySemanticKey(
		purchaseRecordedSemanticKey(purchaseId),
	)
	const buyer = await repository.findContactEventBySemanticKey(
		purchaseRecordedBuyerSemanticKey(purchaseId),
	)
	const contacts = new Map(
		[primary, buyer].flatMap((event) =>
			event ? [[event.contactId, event] as const] : [],
		),
	)
	if (contacts.size === 0)
		throw new Error('Purchase capture not available for refund')
	let written = 0
	let duplicates = 0
	for (const refund of args.refunds) {
		const parsed = purchaseRefundFacts({ purchaseId, refund })
		if (!parsed) continue
		for (const event of contacts.values()) {
			const semanticIdempotencyKey = `ai-hero:purchase.refunded:refund:${parsed.facts.refundId}:contact:${event.contactId}`
			const existing = await repository.findContactEventBySemanticKey(
				semanticIdempotencyKey,
			)
			if (existing) {
				await repository.redispatchContactEvent?.(existing)
				duplicates += 1
				continue
			}
			await repository.createContactEvent({
				provider: 'ai-hero',
				providerEventId: `refund:${parsed.facts.refundId}:contact:${event.contactId}`,
				providerReference: `ai-hero:purchase:${purchaseId}`,
				eventType: 'purchase.refunded',
				occurredAt: parsed.occurredAt,
				semanticIdempotencyKey,
				privacyLevel: 'internal',
				identityEvidence: event.identityEvidence,
				payloadSummary: {
					summary: 'Succeeded charge reversal recorded.',
					keywords: ['purchase-refunded'],
					restrictedPayloadStored: false,
				},
				domainPayload: parsed.facts,
				schemaVersion: CONTACT_EVENT_SCHEMA_VERSION,
				contactId: event.contactId,
				providerIdentityId: event.providerIdentityId,
				createdAt: args.now ?? new Date().toISOString(),
			})
			written += 1
		}
	}
	return { written, duplicates }
}
