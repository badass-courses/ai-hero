import { createHash } from 'node:crypto'
import type { DrovrShadowEvent } from './drovr-shadow-emitter'
import {
	BULK_DELIVERY_SOURCES,
	deliverEventNameFor,
	type DrovrDeliverySource,
	type DrovrContactSyncRetryRequested,
	type DrovrDeliverEnvelope,
} from '@/inngest/events/drovr'
import { bulkOutboxSource } from './contact-sync-bulk'
import type { BulkClass } from './drovr-bulk-pace'
import type { DrovrOutboxSource } from './drovr-outbox'
export const retryEventIdentity = (event: DrovrShadowEvent) =>
	JSON.stringify([
		event.tenantId,
		event.contactId,
		event.journeyId,
		event.idempotencyKey,
	])
export const retryStepKey = (event: DrovrShadowEvent) =>
	createHash('sha256').update(retryEventIdentity(event)).digest('hex')
export type RetryData = DrovrContactSyncRetryRequested['data']
export type RetryRequest = DrovrContactSyncRetryRequested & {
	id: string
	ts: number
}
export function isUncappedOfferRetry(data: RetryData) {
	return (
		!data.paceClass &&
		!data.acknowledge &&
		(!data.deliverySource || !BULK_DELIVERY_SOURCES.has(data.deliverySource)) &&
		[...data.items, ...(data.carry ?? [])].every(
			(item) => item.event.type === 'contact.offer.issued',
		)
	)
}
export function retryPaceClass(data: RetryData): BulkClass {
	switch (data.deliverySource) {
		case 'contact-profile-sync':
			return 'delta'
		case 'contact-profile-restate':
			return 'restate'
		case 'kit-directory-ingest':
			return 'ingest'
		case 'contact-sync-backfill':
		case 'evergreen-pitch-backfill':
			return 'backfill'
		default:
			return (
				data.paceClass ??
				([...data.items, ...(data.carry ?? [])].every((item) =>
					['contact.profile.updated', 'contact.links.issued'].includes(
						item.event.type,
					),
				)
					? 'delta'
					: 'backfill')
			)
	}
}
export function retryDeliverySource(data: RetryData): DrovrDeliverySource {
	if (data.deliverySource && BULK_DELIVERY_SOURCES.has(data.deliverySource))
		return data.deliverySource
	const kind = retryPaceClass(data)
	// Unknown legacy native backfill must not be misread as profile-only
	// backfill and discarded by the latter's producer flag guard.
	return kind === 'delta'
		? 'contact-profile-sync'
		: kind === 'restate'
			? 'contact-profile-restate'
			: kind === 'ingest'
				? 'kit-directory-ingest'
				: 'evergreen-pitch-backfill'
}
export function retryOutboxSource(data: RetryData): DrovrOutboxSource {
	if (isUncappedOfferRetry(data)) return 'contactSync'
	return bulkOutboxSource(retryDeliverySource(data))
}
/** New capped retries bypass the shared legacy retry queue entirely. Reuse
 * the isolated class workers and preserve the old retry ID as a router for
 * queued legacy requests and as the genuine-offer (uncapped) worker.
 */
export function routeContactSyncRetry(
	request: RetryRequest,
): RetryRequest | (DrovrDeliverEnvelope & { id: string; ts: number }) {
	if (isUncappedOfferRetry(request.data)) return request
	const source = retryDeliverySource(request.data)
	const kind = retryPaceClass(request.data)
	return {
		id: `paced-retry:${kind}:${request.id}`,
		ts: request.ts,
		name: deliverEventNameFor(source),
		data: {
			source,
			events: [],
			firstFailedAt: request.data.firstFailedAt,
			stragglerRetry: {
				...request.data,
				paceClass: kind,
				deliverySource: source,
			},
		},
	}
}
