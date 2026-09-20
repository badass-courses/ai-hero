import { env } from '@/env.mjs'
import { DROVR_EVENTS_DELIVER_EVENT } from '@/inngest/events/drovr'
import { inngest } from '@/inngest/inngest.server'
import {
	deliverOrThrow,
	deliveryStepId,
} from '@/lib/subscriber-marketing/drovr-shadow-delivery'
import {
	drovrApiKeyForTenant,
	DROVR_SHADOW_NEWSLETTER_JOURNEY_ID,
	type DrovrDeliveryConfig,
} from '@/lib/subscriber-marketing/drovr-shadow-emitter'
import {
	fanOutOwnedEvents,
	isShadowNewsletterBirth,
} from '@/lib/subscriber-marketing/drovr-ownership'
import { resolveOwnedContactIds } from '@/lib/subscriber-marketing/drovr-ownership-live'
import { log } from '@/server/logger'

export type DrovrEventsDeliverReceipt = {
	status: 'delivered' | 'skipped'
	accepted: number
	rejected: number
	reason?: string
}

/**
 * Durable delivery of drovr events. Each event is its own step keyed by
 * the drovr idempotency key, so a retry after a partial batch never
 * re-posts what already landed, and drovr dedupes anything that does
 * repeat. Concurrency stays modest: drovr's ingress is one D1 append and
 * one Durable Object fold per event.
 */
export const drovrEventsDeliver = inngest.createFunction(
	{
		id: 'drovr-events-deliver-v1',
		name: 'drovr: deliver events durably',
		retries: 6,
		concurrency: { limit: 8 },
	},
	{ event: DROVR_EVENTS_DELIVER_EVENT },
	async ({ event, step }): Promise<DrovrEventsDeliverReceipt> => {
		const ingestUrl = env.DROVR_SHADOW_INGEST_URL
		if (!ingestUrl) {
			return {
				status: 'skipped',
				accepted: 0,
				rejected: 0,
				reason: 'drovr ingest is not configured',
			}
		}

		// Facts about drovr-owned contacts also reach the authority tenant.
		// Ownership is read here, off the host's write path, once per batch.
		const ownedContactIds = await step.run('resolve-drovr-owners', () =>
			resolveOwnedContactIds(event.data.events),
		)
		const newsletterEvents = event.data.events.filter(isShadowNewsletterBirth)
		const newsletterOwnedContactIds = newsletterEvents.length
			? await step.run('resolve-newsletter-owners', () =>
					resolveOwnedContactIds(newsletterEvents, {
						journeyId: DROVR_SHADOW_NEWSLETTER_JOURNEY_ID,
					})
				)
			: []
		const events = fanOutOwnedEvents(
			event.data.events,
			new Set(ownedContactIds),
			new Set(newsletterOwnedContactIds),
		)

		let accepted = 0
		let rejected = 0
		for (const drovrEvent of events) {
			// One bearer key per drovr tenant; a tenant without a key is a
			// configuration gap, final for this run and loud in the receipt.
			const apiKey = drovrApiKeyForTenant(drovrEvent.tenantId)
			if (!apiKey) {
				await log.warn('drovr.shadow.tenant_key_missing', {
					tenantId: drovrEvent.tenantId,
					idempotencyKey: drovrEvent.idempotencyKey,
				})
				rejected += 1
				continue
			}
			const config: DrovrDeliveryConfig = { ingestUrl, apiKey }
			const outcome = await step.run(deliveryStepId(drovrEvent), () =>
				deliverOrThrow({ event: drovrEvent, config }),
			)
			if (outcome.status === 'accepted') accepted += 1
			if (outcome.status === 'rejected') rejected += 1
		}
		return { status: 'delivered', accepted, rejected }
	},
)
