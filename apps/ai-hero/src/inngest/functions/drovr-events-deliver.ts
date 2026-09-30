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
	isNeverBornOwnerStop,
} from '@/lib/subscriber-marketing/drovr-shadow-delivery'
import type {
	DeferredDrovrEvent,
	DrovrBatchOutcome,
} from '@/lib/subscriber-marketing/drovr-shadow-delivery'
import type { DrovrDeliveryOutcome } from '@/lib/subscriber-marketing/drovr-shadow-emitter'
import { contactSyncRetryRequest } from '@/lib/subscriber-marketing/contact-sync-straggler-retry'
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
import { parseDrovrProfileSyncConfig } from '@/lib/subscriber-marketing/drovr-contact-profile-sync-requests'
import { resolveOwnedContactIds } from '@/lib/subscriber-marketing/drovr-ownership-live'
import {
	DROVR_SEND_RETRIES,
	isOutboxStop,
	openStopBefore,
	outboxEntryForEvent,
	type DrovrOutboxSource,
} from '@/lib/subscriber-marketing/drovr-outbox'
import {
	captureDrovrOutboxLive,
	openDrovrOutboxStopsLive,
	type DrovrOutboxOpenStopsFn,
} from '@/lib/subscriber-marketing/drovr-outbox-live'
import {
	sendOrOutbox,
	type DrovrOutboxCaptureFn,
	type DrovrSendAttempt,
} from '@/lib/subscriber-marketing/drovr-outbox-step'
import { withoutSyntheticContacts } from '@/lib/synthetic-principal'
import { log } from '@/server/logger'
import type { GetStepTools } from 'inngest'

export type DrovrEventsDeliverReceipt = {
	/** Backfill events drovr refused, handed to the straggler retry. */
	deferred?: number
	/** Backfill events dropped because contact sync was off. */
	backfillDropped?: number
	status: 'delivered' | 'skipped'
	accepted: number
	rejected: number
	discarded: number
	/**
	 * Of `rejected`, stops' owner copies drovr refused because the contact
	 * never started that journey. The directory stop carries the stop.
	 */
	ownerStopsNeverBorn?: number
	/**
	 * Events that ran out of retries and went to the drovr outbox, whose
	 * replay delivers them (row 204).
	 */
	outboxed?: number
	/**
	 * Of `outboxed`, facts held behind a stop the outbox still owes, so
	 * they never reach drovr ahead of it (row 204b).
	 */
	heldBehindStop?: number
	reason?: string
}

/** How this run delivers: its attempt, its lane, and where unsent go. */
export type DeliverContext = {
	attempt: DrovrSendAttempt
	lane: Extract<DrovrOutboxSource, 'live' | 'bulk'>
	capture: DrovrOutboxCaptureFn
	/** The outbox's owed stops for these contacts (row 204b). */
	openStops: DrovrOutboxOpenStopsFn
}

type Outboxed = { outboxed: number }

const isOutboxed = (value: unknown): value is Outboxed =>
	typeof value === 'object' &&
	value !== null &&
	!Array.isArray(value) &&
	'outboxed' in value

/**
 * What an owner read that ran out of retries leaves for the outbox: the
 * batch before its fan-out, which the replay fans out once it can read.
 * The shadow-addressed events are kept: they are the fan-out candidates,
 * the only road to an owned contact's owner copies (the replay drops the
 * shadow originals after fanning out, as live delivery does). Only
 * synthetic principals are left out.
 */
const ownerReadUnsent = (
	batch: readonly DrovrShadowEvent[],
	lane: DeliverContext['lane'],
) =>
	withoutSyntheticContacts(batch).kept.map((event) =>
		outboxEntryForEvent(event, lane, { needsFanOut: true }),
	)

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
// An owner read that runs out of retries sends the batch, unfanned, to the
// outbox instead of failing the run.
const fanOut = async (
	batch: DrovrEventsDeliver['data']['events'],
	step: DeliverStep,
	context: DeliverContext,
): Promise<DrovrShadowEvent[] | Outboxed> => {
	const readOwners = (read: () => Promise<string[]>) =>
		sendOrOutbox<string[] | Outboxed>({
			attempt: context.attempt,
			send: read,
			unsent: () => ownerReadUnsent(batch, context.lane),
			capture: context.capture,
			outboxed: (outboxed) => ({ outboxed }),
		})
	const ownedContactIds = await step.run('resolve-drovr-owners', () =>
		readOwners(() => resolveOwnedContactIds(batch)),
	)
	if (isOutboxed(ownedContactIds)) return ownedContactIds
	const newsletterEvents = batch.filter(isShadowNewsletterBirth)
	const newsletterOwnedContactIds = newsletterEvents.length
		? await step.run('resolve-newsletter-owners', () =>
				readOwners(() =>
					resolveOwnedContactIds(newsletterEvents, {
						journeyId: DROVR_SHADOW_NEWSLETTER_JOURNEY_ID,
					}),
				),
			)
		: []
	if (isOutboxed(newsletterOwnedContactIds)) return newsletterOwnedContactIds
	return fanOutOwnedEvents(
		batch,
		new Set(ownedContactIds),
		new Set(newsletterOwnedContactIds),
	)
}

/** One event's identity across tenants and journeys (the dedupe inputs). */
const eventIdentity = (event: DrovrShadowEvent) =>
	`${event.tenantId}|${event.journeyId}|${event.idempotencyKey}`

type StopMark = { eventType: string; occurredAt: string }

const stopMarkOf = (event: DrovrShadowEvent): StopMark => ({
	eventType: event.type,
	occurredAt: event.occurredAt,
})

const isBehind = (
	event: DrovrShadowEvent,
	stops: ReadonlyMap<string, StopMark[]>,
) => openStopBefore(stopMarkOf(event), stops.get(event.contactId)) !== undefined

/**
 * Row 204b: a fact that happened at or after a stop the outbox still owes
 * goes to the outbox behind that stop instead of to drovr, where it could
 * start email the stop exists to prevent (a purchase is refused at send
 * time by nothing but drovr knowing). One read per batch. A read that
 * fails is retried; on the last attempt the whole batch goes to the
 * outbox, so a failed read never posts.
 */
const holdBehindOpenStops = async (
	events: DrovrShadowEvent[],
	step: DeliverStep,
	context: DeliverContext,
): Promise<{ events: DrovrShadowEvent[]; held: number; outboxed: number }> => {
	if (events.length === 0) return { events, held: 0, outboxed: 0 }
	const result = await step.run('drovr-outbox-stop-gate', () =>
		sendOrOutbox<{ heldIdentities: string[] } | Outboxed>({
			attempt: context.attempt,
			send: async () => {
				const stops = new Map<string, StopMark[]>()
				for (const stop of await context.openStops([
					...new Set(events.map((event) => event.contactId)),
				])) {
					const list = stops.get(stop.contactId) ?? []
					list.push(stop)
					stops.set(stop.contactId, list)
				}
				const behind = events.filter((event) => isBehind(event, stops))
				if (behind.length === 0) return { heldIdentities: [] }
				await holdInOutbox(behind, context)
				return { heldIdentities: behind.map(eventIdentity) }
			},
			unsent: () =>
				events.map((event) => outboxEntryForEvent(event, context.lane)),
			capture: context.capture,
			outboxed: (outboxed) => ({ outboxed }),
		}),
	)
	if (isOutboxed(result))
		return { events: [], held: 0, outboxed: result.outboxed }
	const held = new Set(result.heldIdentities)
	return {
		events: events.filter((event) => !held.has(eventIdentity(event))),
		held: held.size,
		outboxed: held.size,
	}
}

/** Put held events in the outbox; anything short of that fails the step. */
const holdInOutbox = async (
	behind: readonly DrovrShadowEvent[],
	context: DeliverContext,
) => {
	const captured = await context.capture(
		behind.map((event) => outboxEntryForEvent(event, context.lane)),
		new Error('held behind a stop the outbox still owes'),
	)
	if (captured.status !== 'outboxed')
		throw new Error(
			`could not hold ${behind.length} drovr events behind an owed stop: outbox ${captured.status}`,
		)
	await log.info('drovr.outbox.held_behind_stop', {
		count: behind.length,
		deliveryLane: context.lane,
		idempotencyKeys: behind.map((event) => event.idempotencyKey),
	})
}

/**
 * Events this run held behind a stop it outboxed itself (a stop that ran
 * out of retries earlier in the same run), in one step at the end.
 */
const holdLate = async (
	late: readonly DrovrShadowEvent[],
	step: DeliverStep,
	context: DeliverContext,
): Promise<number> => {
	if (late.length === 0) return 0
	await step.run('drovr-outbox-hold-behind-outboxed-stop', () =>
		holdInOutbox(late, context),
	)
	return late.length
}

const deliverBatch = async (
	batch: DrovrEventsDeliver['data']['events'],
	step: DeliverStep,
	context: DeliverContext,
): Promise<DrovrEventsDeliverReceipt> => {
	const ingestUrl = env.DROVR_SHADOW_INGEST_URL
	if (!ingestUrl) return NOT_CONFIGURED
	const fanOutEvents = await fanOut(batch, step, context)
	if (isOutboxed(fanOutEvents))
		return {
			status: 'delivered',
			accepted: 0,
			rejected: 0,
			discarded: 0,
			outboxed: fanOutEvents.outboxed,
		}
	const shadowFiltered = await discardShadowTenantEvents(fanOutEvents, 'live')
	const { discarded } = shadowFiltered
	const gate = await holdBehindOpenStops(shadowFiltered.events, step, context)
	const events = gate.events

	let accepted = 0
	let rejected = 0
	let ownerStopsNeverBorn = 0
	let outboxed = gate.outboxed
	let heldBehindStop = gate.held
	// Stops this run outboxed: their contacts' later events wait behind them.
	const outboxedStops = new Map<string, StopMark[]>()
	const late: DrovrShadowEvent[] = []
	for (const drovrEvent of events) {
		if (isBehind(drovrEvent, outboxedStops)) {
			late.push(drovrEvent)
			continue
		}
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
		// The log sits in the step so a replay, which gets the memoized
		// outcome back, does not repeat it.
		const outcome = await step.run(deliveryStepId(drovrEvent), () =>
			sendOrOutbox<DrovrDeliveryOutcome | { status: 'outboxed' }>({
				attempt: context.attempt,
				send: async () => {
					const delivered = await deliverOrThrow({ event: drovrEvent, config })
					if (isNeverBornOwnerStop(drovrEvent, delivered)) {
						await log.info('drovr.shadow.owner_stop_never_born', {
							contactId: drovrEvent.contactId,
							journeyId: drovrEvent.journeyId,
							type: drovrEvent.type,
							idempotencyKey: drovrEvent.idempotencyKey,
						})
					}
					return delivered
				},
				unsent: () => [outboxEntryForEvent(drovrEvent, context.lane)],
				capture: context.capture,
				outboxed: () => ({ status: 'outboxed' }),
			}),
		)
		if (outcome.status === 'outboxed') {
			outboxed += 1
			if (isOutboxStop({ eventType: drovrEvent.type })) {
				const list = outboxedStops.get(drovrEvent.contactId) ?? []
				list.push(stopMarkOf(drovrEvent))
				outboxedStops.set(drovrEvent.contactId, list)
			}
			continue
		}
		if (outcome.status === 'accepted') accepted += 1
		if (outcome.status === 'rejected') rejected += 1
		if (isNeverBornOwnerStop(drovrEvent, outcome)) ownerStopsNeverBorn += 1
	}
	const heldLate = await holdLate(late, step, context)
	outboxed += heldLate
	heldBehindStop += heldLate
	return {
		status: 'delivered',
		accepted,
		rejected,
		discarded,
		...(ownerStopsNeverBorn > 0 ? { ownerStopsNeverBorn } : {}),
		...(outboxed > 0 ? { outboxed } : {}),
		...(heldBehindStop > 0 ? { heldBehindStop } : {}),
	}
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
	context: DeliverContext,
	options: {
		/** Contact sync: refusals come back in `refused`, never thrown. */
		deferNotLive?: boolean
		refused?: DeferredDrovrEvent[]
	} = {},
): Promise<DrovrEventsDeliverReceipt> => {
	const ingestUrl = env.DROVR_SHADOW_INGEST_URL
	if (!ingestUrl) return NOT_CONFIGURED
	const fanOutEvents = await fanOut(batch, step, context)
	if (isOutboxed(fanOutEvents))
		return {
			status: 'delivered',
			accepted: 0,
			rejected: 0,
			discarded: 0,
			outboxed: fanOutEvents.outboxed,
		}
	const shadowFiltered = await discardShadowTenantEvents(fanOutEvents, 'bulk')
	const { discarded } = shadowFiltered
	const gate = await holdBehindOpenStops(shadowFiltered.events, step, context)
	const events = gate.events

	// One key per tenant, so one batch stream per tenant.
	const byTenant = new Map<DrovrShadowEvent['tenantId'], DrovrShadowEvent[]>()
	for (const drovrEvent of events) {
		const list = byTenant.get(drovrEvent.tenantId) ?? []
		list.push(drovrEvent)
		byTenant.set(drovrEvent.tenantId, list)
	}

	let accepted = 0
	let rejected = 0
	let outboxed = gate.outboxed
	let heldBehindStop = gate.held
	// Stops in a chunk this run outboxed hold their contacts' later events
	// in the chunks after it.
	const outboxedStops = new Map<string, StopMark[]>()
	const late: DrovrShadowEvent[] = []
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
			const sliced = tenantEvents.slice(
				chunkIndex * DROVR_BATCH_MAX,
				(chunkIndex + 1) * DROVR_BATCH_MAX,
			)
			const chunk = sliced.filter((event) => !isBehind(event, outboxedStops))
			late.push(...sliced.filter((event) => isBehind(event, outboxedStops)))
			if (chunk.length === 0) continue
			// A chunk that runs out of retries goes to the outbox whole:
			// drovr dedupes the items that did land when the replay re-posts.
			const outcome = (await step.run(batchStepId(tenantId, chunkIndex), () =>
				sendOrOutbox<DrovrBatchOutcome & Partial<Outboxed>>({
					attempt: context.attempt,
					send: () =>
						deliverBatchOrThrow(
							options.deferNotLive
								? { events: chunk, config, deferNotLive: true }
								: { events: chunk, config },
						),
					unsent: () =>
						chunk.map((event) => outboxEntryForEvent(event, context.lane)),
					capture: context.capture,
					outboxed: (count) => ({ accepted: 0, rejected: 0, outboxed: count }),
				}),
			)) as DrovrBatchOutcome & Partial<Outboxed>
			accepted += outcome.accepted
			rejected += outcome.rejected
			outboxed += outcome.outboxed ?? 0
			options.refused?.push(...(outcome.deferred ?? []))
			if (outcome.outboxed)
				for (const event of chunk)
					if (isOutboxStop({ eventType: event.type })) {
						const list = outboxedStops.get(event.contactId) ?? []
						list.push(stopMarkOf(event))
						outboxedStops.set(event.contactId, list)
					}
		}
	}
	const heldLate = await holdLate(late, step, context)
	outboxed += heldLate
	heldBehindStop += heldLate
	return {
		status: 'delivered',
		accepted,
		rejected,
		discarded,
		...(outboxed > 0 ? { outboxed } : {}),
		...(heldBehindStop > 0 ? { heldBehindStop } : {}),
	}
}

export const drovrEventsDeliver = inngest.createFunction(
	{
		id: 'drovr-events-deliver-v1',
		name: 'drovr: deliver events durably',
		retries: DROVR_SEND_RETRIES,
		concurrency: [{ limit: 8 }],
		// The backstop: a run that died before its sends could outbox them
		// (row 204). Its events go unfanned; the replay fans them out.
		onFailure: async ({ event, error }) => {
			await outboxFailedRun(event.data.event.data, error)
		},
	},
	{ event: DROVR_EVENTS_DELIVER_EVENT },
	async ({ event, step, attempt, maxAttempts }) => {
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
		return deliverBatch(event.data.events, step, {
			attempt: { attempt, maxAttempts },
			lane: 'live',
			capture: captureDrovrOutboxLive,
			openStops: openDrovrOutboxStopsLive,
		})
	},
)

/** The live function's onFailure: its whole batch, unfanned, to the outbox. */
export async function outboxFailedRun(
	data: DrovrEventsDeliver['data'],
	error: unknown,
	capture: DrovrOutboxCaptureFn = captureDrovrOutboxLive,
): Promise<void> {
	if (BULK_DELIVERY_SOURCES.has(data.source)) return
	const entries = ownerReadUnsent(data.events, 'live').map((entry) => ({
		...entry,
		source: 'onFailure' as const,
	}))
	if (entries.length === 0) return
	try {
		await capture(entries, error)
	} catch (captureError) {
		await log.error('drovr.outbox.on_failure_capture_failed', {
			count: entries.length,
			error:
				captureError instanceof Error
					? captureError.message
					: String(captureError),
			idempotencyKeys: entries.map((entry) => entry.idempotencyKey),
		})
	}
}

const withStepPrefix = (step: DeliverStep, prefix: string): DeliverStep =>
	({
		...step,
		run: (id: string, operation: () => unknown) =>
			step.run(`${prefix}${id}`, operation),
	}) as DeliverStep

const combineReceipts = (
	receipts: DrovrEventsDeliverReceipt[],
): DrovrEventsDeliverReceipt => {
	const delivered = receipts.filter((receipt) => receipt.status === 'delivered')
	if (receipts.length > 0 && delivered.length === 0) return receipts[0]!
	return {
		status: 'delivered',
		accepted: delivered.reduce((sum, receipt) => sum + receipt.accepted, 0),
		rejected: delivered.reduce((sum, receipt) => sum + receipt.rejected, 0),
		discarded: delivered.reduce((sum, receipt) => sum + receipt.discarded, 0),
		...(delivered.some((receipt) => receipt.outboxed)
			? {
					outboxed: delivered.reduce(
						(sum, receipt) => sum + (receipt.outboxed ?? 0),
						0,
					),
				}
			: {}),
		...(delivered.some((receipt) => receipt.heldBehindStop)
			? {
					heldBehindStop: delivered.reduce(
						(sum, receipt) => sum + (receipt.heldBehindStop ?? 0),
						0,
					),
				}
			: {}),
	}
}

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
		retries: DROVR_SEND_RETRIES,
		concurrency: [{ limit: 4 }],
		batchEvents: BULK_DELIVERY_BATCH,
	},
	{ event: DROVR_EVENTS_DELIVER_BULK_EVENT },
	async ({ events, step, attempt, maxAttempts }) => {
		const context: DeliverContext = {
			attempt: { attempt, maxAttempts },
			lane: 'bulk',
			capture: captureDrovrOutboxLive,
			openStops: openDrovrOutboxStopsLive,
		}
		const isBackfill = (bulkEvent: (typeof events)[number]) =>
			bulkEvent.data.source === 'contact-sync-backfill'
		const others = events
			.filter((bulkEvent) => !isBackfill(bulkEvent))
			.flatMap((bulkEvent) => bulkEvent.data.events)
		const backfill = events
			.filter(isBackfill)
			.flatMap((bulkEvent) => bulkEvent.data.events)
		// Other sources keep today's step ids and chunk layout whatever the
		// flag says, so a retry never shifts their events into a chunk whose
		// memoized result would replay without posting them.
		const receipts: DrovrEventsDeliverReceipt[] = []
		if (others.length > 0 || backfill.length === 0)
			receipts.push(await deliverBulk(others, step, context))
		if (backfill.length === 0) return receipts[0]!
		// A drovr rollback turns AIH_DROVR_PROFILE_SYNC off; backfill pages
		// still queued (or retrying) must not reach old drovr code, which
		// burns their keys without an event-not-live guard. They are
		// dropped, not held, so nothing lands in the window: the backfill is
		// idempotent and re-runs once drovr is back. Their own step ids
		// keep them out of the other sources' chunks.
		if (!parseDrovrProfileSyncConfig(process.env).enabled) {
			await log.warn('drovr.contact_sync.backfill_dropped', {
				count: backfill.length,
				reason: 'AIH_DROVR_PROFILE_SYNC is off; re-run the backfill',
			})
			return {
				...combineReceipts(receipts),
				backfillDropped: backfill.length,
			}
		}
		// Contract §4: refusals go to the straggler retry, unchanged and
		// under their keys; cold-start at once (the retry births the actor
		// and pushes again), event-not-live after drovr's daily pass.
		const backfillStep = withStepPrefix(step, 'contact-sync-backfill:')
		const refused: DeferredDrovrEvent[] = []
		receipts.push(
			await deliverBulk(backfill, backfillStep, context, {
				deferNotLive: true,
				refused,
			}),
		)
		if (refused.length === 0) return combineReceipts(receipts)
		const at = (await backfillStep.run('defer-at', async () =>
			Date.now(),
		)) as number
		const notLive = refused.filter(
			(item) => item.reason !== 'cold-start-unhandled',
		)
		const coldStart = refused.filter(
			(item) => item.reason === 'cold-start-unhandled',
		)
		await step.sendEvent('contact-sync-backfill:defer-refused', [
			...(notLive.length > 0 ? [contactSyncRetryRequest(notLive, 1, at)] : []),
			...(coldStart.length > 0
				? [{ ...contactSyncRetryRequest(coldStart, 1, at), ts: at }]
				: []),
		])
		return { ...combineReceipts(receipts), deferred: refused.length }
	},
)
