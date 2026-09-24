import { env } from '@/env.mjs'
import {
	BULK_DELIVERY_SOURCES,
	DROVR_EVENTS_DELIVER_BULK_EVENT,
	DROVR_EVENTS_DELIVER_EVENT,
} from '@/inngest/events/drovr'
import type { DrovrEventsDeliver } from '@/inngest/events/drovr'
import { inngest } from '@/inngest/inngest.server'
import {
	batchStepId,
	deliverBatchOrThrow,
	deliverOrThrow,
	deliveryStepId,
	DROVR_BATCH_MAX,
} from '@/lib/subscriber-marketing/drovr-shadow-delivery'
import {
	drovrApiKeyForTenant,
	DROVR_SHADOW_NEWSLETTER_JOURNEY_ID,
	DROVR_SHADOW_TENANT_ID,
	type DrovrDeliveryConfig,
	type DrovrShadowEvent,
} from '@/lib/subscriber-marketing/drovr-shadow-emitter'
import {
	fanOutOwnedEvents,
	isShadowNewsletterBirth,
} from '@/lib/subscriber-marketing/drovr-ownership'
import { resolveOwnedContactIds } from '@/lib/subscriber-marketing/drovr-ownership-live'
import { withoutSyntheticContacts } from '@/lib/synthetic-principal'
import { log } from '@/server/logger'
import type { GetStepTools } from 'inngest'

export type DrovrEventsDeliverReceipt = {
	status: 'delivered' | 'skipped'
	accepted: number
	rejected: number
	discarded: number
	reason?: string
}

/**
 * Durable delivery of drovr events. Each event is its own step keyed by
 * the drovr idempotency key, so a retry after a partial batch never
 * re-posts what already landed, and drovr dedupes anything that does
 * repeat. Concurrency stays modest: drovr's ingress is one D1 append and
 * one Durable Object fold per event.
 *
 * Bulk producers do not share this function. A per-source concurrency key
 * (#260) was tried first: it caps a source's slots but not its place in
 * the one function queue, and on 2026-09-21 a Kit page's thousand
 * one-contact deliveries held every live fact `Scheduled` for two hours.
 * Inngest's own queue posts describe the mechanism (scan windows filled by
 * concurrency-blocked items). A separate function is a separate queue.
 */
type DeliverStep = GetStepTools<typeof inngest>

const NOT_CONFIGURED: DrovrEventsDeliverReceipt = {
	status: 'skipped',
	accepted: 0,
	rejected: 0,
	discarded: 0,
	reason: 'drovr ingest is not configured',
}

const discardShadowTenantEvents = async (
	events: readonly DrovrShadowEvent[],
	deliveryLane: 'live' | 'bulk',
): Promise<{ events: DrovrShadowEvent[]; discarded: number }> => {
	// Synthetic test principals never reach drovr: no actor born or advanced.
	const real = withoutSyntheticContacts(events)
	if (real.discarded > 0) {
		await log.info('drovr.shadow.synthetic_discarded', {
			count: real.discarded,
			deliveryLane,
		})
	}
	const deliverable = real.kept.filter(
		(event) => event.tenantId !== DROVR_SHADOW_TENANT_ID,
	)
	const discarded = real.kept.length - deliverable.length
	if (discarded > 0) {
		await log.info('drovr.shadow.events_discarded', {
			tenantId: DROVR_SHADOW_TENANT_ID,
			count: discarded,
			deliveryLane,
		})
	}
	return { events: deliverable, discarded: discarded + real.discarded }
}

// Facts about drovr-owned contacts also reach the authority tenant.
// Ownership is read here, off the host's write path, once per batch.
const fanOut = async (
	batch: DrovrEventsDeliver['data']['events'],
	step: DeliverStep,
): Promise<DrovrShadowEvent[]> => {
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
	return fanOutOwnedEvents(
		batch,
		new Set(ownedContactIds),
		new Set(newsletterOwnedContactIds),
	)
}

const deliverBatch = async (
	batch: DrovrEventsDeliver['data']['events'],
	step: DeliverStep,
): Promise<DrovrEventsDeliverReceipt> => {
	const ingestUrl = env.DROVR_SHADOW_INGEST_URL
	if (!ingestUrl) return NOT_CONFIGURED
	const fanOutEvents = await fanOut(batch, step)
	const { events, discarded } = await discardShadowTenantEvents(
		fanOutEvents,
		'live',
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
	return { status: 'delivered', accepted, rejected, discarded }
}

/**
 * The bulk shape: one step per tenant chunk of up to a hundred events
 * through drovr's `POST /events/batch`, instead of one step and one POST
 * per contact. A Kit page is then ten steps, not a thousand. The live
 * function keeps one step per event: a signup's welcome should not wait
 * on its neighbours, and dual-journey facts need their per-journey step.
 */
const deliverBulk = async (
	batch: DrovrEventsDeliver['data']['events'],
	step: DeliverStep,
): Promise<DrovrEventsDeliverReceipt> => {
	const ingestUrl = env.DROVR_SHADOW_INGEST_URL
	if (!ingestUrl) return NOT_CONFIGURED
	const fanOutEvents = await fanOut(batch, step)
	const { events, discarded } = await discardShadowTenantEvents(
		fanOutEvents,
		'bulk',
	)

	// One key per tenant, so one batch stream per tenant.
	const byTenant = new Map<DrovrShadowEvent['tenantId'], DrovrShadowEvent[]>()
	for (const drovrEvent of events) {
		const list = byTenant.get(drovrEvent.tenantId) ?? []
		list.push(drovrEvent)
		byTenant.set(drovrEvent.tenantId, list)
	}

	let accepted = 0
	let rejected = 0
	for (const [tenantId, tenantEvents] of byTenant) {
		const apiKey = drovrApiKeyForTenant(tenantId)
		if (!apiKey) {
			await log.warn('drovr.shadow.tenant_key_missing', {
				tenantId,
				count: tenantEvents.length,
			})
			rejected += tenantEvents.length
			continue
		}
		const config: DrovrDeliveryConfig = { ingestUrl, apiKey }
		for (
			let chunkIndex = 0;
			chunkIndex * DROVR_BATCH_MAX < tenantEvents.length;
			chunkIndex += 1
		) {
			const chunk = tenantEvents.slice(
				chunkIndex * DROVR_BATCH_MAX,
				(chunkIndex + 1) * DROVR_BATCH_MAX,
			)
			const outcome = await step.run(batchStepId(tenantId, chunkIndex), () =>
				deliverBatchOrThrow({ events: chunk, config }),
			)
			accepted += outcome.accepted
			rejected += outcome.rejected
		}
	}
	return { status: 'delivered', accepted, rejected, discarded }
}

export const drovrEventsDeliver = inngest.createFunction(
	{
		id: 'drovr-events-deliver-v1',
		name: 'drovr: deliver events durably',
		retries: 6,
		concurrency: [{ limit: 8 }],
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
				discarded: 0,
				reason: 'bulk source on the live function',
			}
		}
		return deliverBatch(event.data.events, step)
	},
)

/**
 * Bulk producers' batches, on their own function and so their own queue.
 * Four slots: drovr folds a birth in about two seconds, and the live
 * function's eight stay untouched.
 *
 * Inngest folds up to a hundred bulk events into one run before it is
 * queued, so a Kit page (about a thousand one-contact events in a second)
 * becomes ten queue items instead of a thousand, and the owner lookups run
 * once per hundred contacts instead of once per contact. Each contact is
 * still its own step, keyed by its drovr idempotency key, so a retry after
 * a partial run never re-posts what already landed. Drovr's ingress takes
 * one event per request; a batch ingress there is the next step down.
 */
export const BULK_DELIVERY_BATCH = { maxSize: 100, timeout: '10s' } as const

export const drovrEventsDeliverBulk = inngest.createFunction(
	{
		id: 'drovr-events-deliver-bulk-v1',
		name: 'drovr: deliver bulk events durably',
		retries: 6,
		concurrency: [{ limit: 4 }],
		batchEvents: BULK_DELIVERY_BATCH,
	},
	{ event: DROVR_EVENTS_DELIVER_BULK_EVENT },
	async ({ events, step }) =>
		deliverBulk(
			events.flatMap((bulkEvent) => bulkEvent.data.events),
			step,
		),
)
