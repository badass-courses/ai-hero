import { env } from '@/env.mjs'
import {
	BULK_DELIVERY_SOURCES,
	DROVR_EVENTS_DELIVER_BULK_EVENT,
	DROVR_EVENTS_DELIVER_EVENT,
} from '@/inngest/events/drovr'
import type { DrovrEventsDeliver } from '@/inngest/events/drovr'
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
import type { GetStepTools } from 'inngest'

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
 *
 * The second concurrency entry keys a sub-queue per `event.data.source`
 * (the fact kind). Bulk producers such as the Kit directory ingest emit
 * thousands of `contact-created` facts in minutes; without the key they
 * filled every slot and live signups (`contact-event`,
 * `side-effect-intent-completed`) waited behind them (2026-09-20: 4.5 min
 * of queue lag within twenty minutes of starting the ingest). With it, one
 * source can hold at most half the slots and the others keep their own
 * queues.
 */
type DeliverStep = GetStepTools<typeof inngest>

const deliverBatch = async (
	batch: DrovrEventsDeliver['data']['events'],
	step: DeliverStep,
): Promise<DrovrEventsDeliverReceipt> => {
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
		resolveOwnedContactIds(batch),
	)
	const newsletterEvents = batch.filter(isShadowNewsletterBirth)
	const newsletterOwnedContactIds = newsletterEvents.length
		? await step.run('resolve-newsletter-owners', () =>
				resolveOwnedContactIds(newsletterEvents, {
					journeyId: DROVR_SHADOW_NEWSLETTER_JOURNEY_ID,
				}),
			)
		: []
	const events = fanOutOwnedEvents(
		batch,
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
}

export const drovrEventsDeliver = inngest.createFunction(
	{
		id: 'drovr-events-deliver-v1',
		name: 'drovr: deliver events durably',
		retries: 6,
		concurrency: [{ limit: 8 }, { key: 'event.data.source', limit: 4 }],
	},
	{ event: DROVR_EVENTS_DELIVER_EVENT },
	async ({ event, step }) => {
		// A bulk source can only reach this function as a leftover from
		// before the bulk function existed (2026-09-21: ~8,000 Kit births
		// queued ahead of live facts). Answer it in milliseconds instead of
		// folding it; the directory seed top-up rebirths what it skipped.
		if (BULK_DELIVERY_SOURCES.has(event.data.source)) {
			return {
				status: 'skipped',
				accepted: 0,
				rejected: 0,
				reason: 'bulk source on the live function',
			}
		}
		return deliverBatch(event.data.events, step)
	},
)

/**
 * Bulk producers' batches, on their own function and so their own queue.
 * The keyed entry above caps a source's slots but not its place in line:
 * a Kit page's thousand one-contact deliveries sat ahead of the live and
 * completion lanes and those waited eleven minutes (2026-09-21 04:44Z).
 * Four slots: drovr folds a birth in about two seconds, and the live
 * function's eight stay untouched.
 */
export const drovrEventsDeliverBulk = inngest.createFunction(
	{
		id: 'drovr-events-deliver-bulk-v1',
		name: 'drovr: deliver bulk events durably',
		retries: 6,
		concurrency: [{ limit: 4 }],
	},
	{ event: DROVR_EVENTS_DELIVER_BULK_EVENT },
	async ({ event, step }) => deliverBatch(event.data.events, step),
)
