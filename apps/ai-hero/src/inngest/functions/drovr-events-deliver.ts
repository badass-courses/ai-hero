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
import {
	isHeldStopRefusal,
	refusalsByAnswer,
} from '@/lib/subscriber-marketing/drovr-stop-verdict'
import type {
	DeferredDrovrEvent,
	DrovrBatchOutcome,
	RefusedDrovrEvent,
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
	DROVR_OUTBOX_BEHIND_STOP_NOTE,
	DROVR_OUTBOX_DEFERRED_STOP_WAIT_MS,
	DROVR_SEND_RETRIES,
	isOutboxBirth,
	isOutboxStop,
	openStopBefore,
	outboxEntryForEvent,
	type DrovrOutboxEntry,
	type DrovrOutboxSource,
} from '@/lib/subscriber-marketing/drovr-outbox'
import {
	captureDrovrOutboxLive,
	holdDrovrStopsLive,
	openDrovrOutboxStopsLive,
	settleDrovrOutboxLive,
	type DrovrOutboxOpenStopsFn,
} from '@/lib/subscriber-marketing/drovr-outbox-live'
import {
	DROVR_SETTLED_BY_RETRY,
	sendOrOutbox,
	type DrovrOutboxCaptureFn,
	type DrovrOutboxHoldFn,
	type DrovrOutboxSettleFn,
	type DrovrSendAttempt,
	type DrovrStopsEarly,
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
	/**
	 * Stops drovr refused with a 4xx that is not "never born", held in the
	 * outbox for a human instead of counted rejected (row 204c). They gate
	 * their contacts' later events like any owed stop.
	 */
	heldStops?: number
	/**
	 * Backfill stops drovr answered event-not-live: handed to the straggler
	 * retry, and also outboxed so they gate meanwhile (row 204c).
	 */
	deferredStopsGated?: number
	reason?: string
}

/** How this run delivers: its attempt, its lane, and where unsent go. */
export type DeliverContext = {
	attempt: DrovrSendAttempt
	lane: Extract<DrovrOutboxSource, 'live' | 'bulk'>
	capture: DrovrOutboxCaptureFn
	/** The outbox's owed stops for these contacts (row 204b). */
	openStops: DrovrOutboxOpenStopsFn
	/** Marks stops captured on a first failure delivered once a retry lands. */
	settle: DrovrOutboxSettleFn
	/** Holds stops drovr refused with a 4xx, for a human (row 204c). */
	hold: DrovrOutboxHoldFn
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

const isStopEvent = (event: DrovrShadowEvent) =>
	isOutboxStop({ eventType: event.type })

const isBirthEvent = (event: DrovrShadowEvent) =>
	isOutboxBirth({
		endpoint: 'events',
		eventType: event.type,
		journeyId: event.journeyId,
	})

/**
 * Row 204b: deliver in the order things happened, so a stop that fails is
 * never behind a later fact that already posted, with the replay's one
 * exception (`replayOrder`): a birth moves up to just ahead of the earliest
 * event of its contact and journey, since drovr takes nothing for a contact
 * it never saw born. On a shared instant a birth goes first, then stops,
 * then facts. Stable, so a retry sees the same order. An instant that does
 * not parse fails closed: such a stop goes first, so it holds everything
 * after it if it fails, and any other event goes last, behind every stop.
 */
export function inDeliveryOrder(
	events: readonly DrovrShadowEvent[],
): DrovrShadowEvent[] {
	const instant = (event: DrovrShadowEvent) => {
		const at = Date.parse(event.occurredAt)
		if (!Number.isNaN(at)) return at
		return isStopEvent(event)
			? Number.NEGATIVE_INFINITY
			: Number.POSITIVE_INFINITY
	}
	const placed = events.map((event, index) => {
		let at = instant(event)
		if (isBirthEvent(event))
			for (const other of events)
				if (
					!isBirthEvent(other) &&
					other.contactId === event.contactId &&
					other.journeyId === event.journeyId
				)
					at = Math.min(at, instant(other))
		const rank = isBirthEvent(event) ? 0 : isStopEvent(event) ? 1 : 2
		return { event, index, at, rank }
	})
	return placed
		.sort((a, b) => a.at - b.at || a.rank - b.rank || a.index - b.index)
		.map(({ event }) => event)
}

/** The stops among these events, for their capture on a first failure. */
const earlyStops = <T>(
	events: readonly DrovrShadowEvent[],
	context: DeliverContext,
	noteFor: (result: T) => string | null,
	landed?: DrovrStopsEarly<T>['landed'],
): DrovrStopsEarly<T> => ({
	stops: () =>
		events
			.filter(isStopEvent)
			.map((event) => outboxEntryForEvent(event, context.lane)),
	settle: context.settle,
	noteFor,
	...(landed ? { landed } : {}),
})

/** A chunk's stops less those its answer held or deferred (row 204c). */
const landedStops = (
	outcome: { gatedKeys?: string[]; deferred?: DeferredDrovrEvent[] },
	stops: readonly DrovrOutboxEntry[],
) => {
	const owed = new Set([
		...(outcome.gatedKeys ?? []),
		...(outcome.deferred ?? []).map(({ event }) => event.idempotencyKey),
	])
	return stops.filter((stop) => !owed.has(stop.idempotencyKey))
}

const SETTLED_REFUSED =
	'refused by drovr on an Inngest retry: never born there, nothing owed'

/** The stops among drovr's final refusals that must be held (row 204c). */
const stopsToHold = (refused: readonly RefusedDrovrEvent[]) =>
	refused.filter(isHeldStopRefusal)

const refusalReason = (httpStatus: number, problem: unknown) =>
	`drovr refused the stop (${httpStatus}): ${JSON.stringify(problem ?? null)}`

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
		new Error(DROVR_OUTBOX_BEHIND_STOP_NOTE),
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
	const events = inDeliveryOrder(gate.events)

	let accepted = 0
	let rejected = 0
	let ownerStopsNeverBorn = 0
	let heldStops = 0
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
			sendOrOutbox<
				DrovrDeliveryOutcome | { status: 'outboxed' } | { status: 'held' }
			>({
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
						return delivered
					}
					// Row 204c: a stop refused for any other reason is held for a
					// human, on this attempt or a retry, never counted as sent.
					if (delivered.status === 'rejected' && isStopEvent(drovrEvent)) {
						const held = await context.hold(
							[outboxEntryForEvent(drovrEvent, context.lane)],
							refusalReason(delivered.httpStatus, delivered.problem),
							delivered.httpStatus,
						)
						if (held.status === 'outboxed') return { status: 'held' as const }
					}
					return delivered
				},
				unsent: () => [outboxEntryForEvent(drovrEvent, context.lane)],
				capture: context.capture,
				outboxed: () => ({ status: 'outboxed' }),
				early: earlyStops([drovrEvent], context, (outcome) =>
					outcome.status === 'held'
						? null
						: outcome.status === 'rejected'
							? SETTLED_REFUSED
							: DROVR_SETTLED_BY_RETRY,
				),
			}),
		)
		if (outcome.status === 'held') {
			heldStops += 1
			const list = outboxedStops.get(drovrEvent.contactId) ?? []
			list.push(stopMarkOf(drovrEvent))
			outboxedStops.set(drovrEvent.contactId, list)
			continue
		}
		if (outcome.status === 'outboxed') {
			outboxed += 1
			if (isStopEvent(drovrEvent)) {
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
		...(heldStops > 0 ? { heldStops } : {}),
	}
}

/**
 * The bulk shape: one step per tenant chunk of up to a hundred events
 * through drovr's `POST /events/batch`, instead of one step and one POST
 * per contact. A Kit page is then ten steps, not a thousand. The live
 * function keeps one step per event: a signup's welcome should not wait
 * on its neighbours, and dual-journey facts need their per-journey step.
 */
/** A chunk's memoized answer: the counts, and which of its stops now gate. */
type ChunkOutcome = Omit<DrovrBatchOutcome, 'refused'> & {
	heldStops?: number
	deferredStopsGated?: number
	/** Stops held or deferred and outboxed: they gate the chunks after. */
	gatedKeys?: string[]
}

const deliverBulk = async (
	batch: DrovrEventsDeliver['data']['events'],
	step: DeliverStep,
	context: DeliverContext,
	options: {
		/** Contact sync: refusals come back in `refused`, never thrown. */
		deferNotLive?: boolean
		refused?: DeferredDrovrEvent[]
		/**
		 * The run's owed stops by contact, shared across calls, so a stop one
		 * call outboxed or held holds the other call's later events (row 204c).
		 */
		gate?: Map<string, StopMark[]>
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
	// In time order, so chunks go out oldest first. After the shadow tenant
	// is discarded only the authority tenant is left, so that order is the
	// whole batch's.
	const events = inDeliveryOrder(gate.events)

	// One key per tenant, so one batch stream per tenant.
	const byTenant = new Map<DrovrShadowEvent['tenantId'], DrovrShadowEvent[]>()
	for (const drovrEvent of events) {
		const list = byTenant.get(drovrEvent.tenantId) ?? []
		list.push(drovrEvent)
		byTenant.set(drovrEvent.tenantId, list)
	}

	let accepted = 0
	let rejected = 0
	let heldStops = 0
	let deferredStopsGated = 0
	let outboxed = gate.outboxed
	let heldBehindStop = gate.held
	// Stops in a chunk this run outboxed, held or deferred hold their
	// contacts' later events in the chunks after it.
	const outboxedStops = options.gate ?? new Map<string, StopMark[]>()
	const gateOn = (event: DrovrShadowEvent) => {
		const list = outboxedStops.get(event.contactId) ?? []
		list.push(stopMarkOf(event))
		outboxedStops.set(event.contactId, list)
	}
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
			// `by-time:` since the chunks follow time order (row 204b): a run
			// in flight across that deploy re-posts its chunks, which drovr
			// dedupes, instead of replaying a memoized chunk that now holds
			// other events.
			const stepId = `by-time:${batchStepId(tenantId, chunkIndex)}`
			const outcome = (await step.run(stepId, () =>
				sendOrOutbox<ChunkOutcome & Partial<Outboxed>>({
					attempt: context.attempt,
					send: async () => {
						const answer = await deliverBatchOrThrow(
							options.deferNotLive
								? { events: chunk, config, deferNotLive: true }
								: { events: chunk, config },
						)
						const { refused = [], ...counts } = answer
						const gatedKeys: string[] = []
						// Row 204c: a stop drovr refused for good (not "never born")
						// is held for a human, not counted rejected.
						let held = 0
						for (const group of refusalsByAnswer(stopsToHold(refused))) {
							const { httpStatus, problem } = group[0]!
							const captured = await context.hold(
								group.map(({ event }) =>
									outboxEntryForEvent(event, context.lane),
								),
								refusalReason(httpStatus, problem),
								httpStatus,
							)
							if (captured.status === 'outboxed') {
								held += group.length
								gatedKeys.push(
									...group.map(({ event }) => event.idempotencyKey),
								)
							}
						}
						// A backfill stop drovr answered event-not-live goes to the
						// straggler retry, and to the outbox too, so it gates its
						// contact until it lands (row 204c). The straggler owns it
						// for a day; the replay after that.
						const deferredStops = (counts.deferred ?? []).filter(({ event }) =>
							isStopEvent(event),
						)
						let deferredGated = 0
						if (deferredStops.length > 0) {
							const captured = await context.capture(
								deferredStops.map(({ event }) =>
									outboxEntryForEvent(event, 'contactSync'),
								),
								new Error(
									'drovr answered event-not-live: the contact-sync straggler retry owns it',
								),
								{
									nextAttemptAt: new Date(
										Date.now() + DROVR_OUTBOX_DEFERRED_STOP_WAIT_MS,
									),
								},
							)
							if (captured.status === 'outboxed') {
								deferredGated = deferredStops.length
								gatedKeys.push(
									...deferredStops.map(({ event }) => event.idempotencyKey),
								)
							}
						}
						return {
							...counts,
							rejected: counts.rejected - held,
							...(held > 0 ? { heldStops: held } : {}),
							...(deferredGated > 0
								? { deferredStopsGated: deferredGated }
								: {}),
							...(gatedKeys.length > 0 ? { gatedKeys } : {}),
						}
					},
					unsent: () =>
						chunk.map((event) => outboxEntryForEvent(event, context.lane)),
					capture: context.capture,
					outboxed: (count) => ({ accepted: 0, rejected: 0, outboxed: count }),
					// Held and deferred stops left pending are not touched: the
					// settle moves only pending rows, and those two are held or
					// owned by the straggler retry.
					early: earlyStops<ChunkOutcome & Partial<Outboxed>>(
						chunk,
						context,
						(outcome) =>
							outcome.rejected > 0
								? `settled by an Inngest retry: its chunk was answered, and drovr refused ${outcome.rejected} item(s) that are not stops (or never born there), final and counted rejected`
								: DROVR_SETTLED_BY_RETRY,
						landedStops,
					),
				}),
			)) as ChunkOutcome & Partial<Outboxed>
			accepted += outcome.accepted
			rejected += outcome.rejected
			outboxed += outcome.outboxed ?? 0
			heldStops += outcome.heldStops ?? 0
			deferredStopsGated += outcome.deferredStopsGated ?? 0
			options.refused?.push(...(outcome.deferred ?? []))
			if (outcome.outboxed)
				for (const event of chunk) if (isStopEvent(event)) gateOn(event)
			const gated = new Set(outcome.gatedKeys ?? [])
			for (const event of chunk)
				if (gated.has(event.idempotencyKey)) gateOn(event)
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
		...(heldStops > 0 ? { heldStops } : {}),
		...(deferredStopsGated > 0 ? { deferredStopsGated } : {}),
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
			settle: settleDrovrOutboxLive,
			hold: holdDrovrStopsLive,
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
	const sumOf = (
		field: 'outboxed' | 'heldBehindStop' | 'heldStops' | 'deferredStopsGated',
	) => {
		const total = delivered.reduce(
			(sum, receipt) => sum + (receipt[field] ?? 0),
			0,
		)
		return total > 0 ? { [field]: total } : {}
	}
	return {
		status: 'delivered',
		accepted: delivered.reduce((sum, receipt) => sum + receipt.accepted, 0),
		rejected: delivered.reduce((sum, receipt) => sum + receipt.rejected, 0),
		discarded: delivered.reduce((sum, receipt) => sum + receipt.discarded, 0),
		...sumOf('outboxed'),
		...sumOf('heldBehindStop'),
		...sumOf('heldStops'),
		...sumOf('deferredStopsGated'),
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

/**
 * Row 201g: the bulk lane is the paced path for births (the hawk,
 * 2026-09-30). Inngest's throttle counts run starts, not events, and a run
 * folds up to BULK_DELIVERY_BATCH.maxSize bulk events, so 7 runs a minute
 * is at most 700 bulk events a minute (under the 750 births/min bulk cap).
 * Run starts are spaced evenly through the minute. A producer that puts one
 * birth in each bulk event (the evergreen pitch backfill) is paced at 700
 * births a minute; the Kit ingest and the contact-sync backfill carry
 * directory events, which cost the birth minute but start no drips.
 */
export const BULK_DELIVERY_THROTTLE = { limit: 7, period: '1m' } as const

export const drovrEventsDeliverBulk = inngest.createFunction(
	{
		id: 'drovr-events-deliver-bulk-v1',
		name: 'drovr: deliver bulk events durably',
		retries: DROVR_SEND_RETRIES,
		concurrency: [{ limit: 4 }],
		batchEvents: BULK_DELIVERY_BATCH,
		throttle: BULK_DELIVERY_THROTTLE,
	},
	{ event: DROVR_EVENTS_DELIVER_BULK_EVENT },
	async ({ events, step, attempt, maxAttempts }) => {
		const context: DeliverContext = {
			attempt: { attempt, maxAttempts },
			lane: 'bulk',
			capture: captureDrovrOutboxLive,
			openStops: openDrovrOutboxStopsLive,
			settle: settleDrovrOutboxLive,
			hold: holdDrovrStopsLive,
		}
		const isBackfill = (bulkEvent: (typeof events)[number]) =>
			bulkEvent.data.source === 'contact-sync-backfill'
		const others = events
			.filter((bulkEvent) => !isBackfill(bulkEvent))
			.flatMap((bulkEvent) => bulkEvent.data.events)
		const backfill = events
			.filter(isBackfill)
			.flatMap((bulkEvent) => bulkEvent.data.events)
		// Each source keeps its own step ids and chunk layout whatever the
		// flag says, so a retry never shifts events into a chunk whose
		// memoized result would replay without posting them. The backfill
		// goes first, and one stop map is shared, so a backfill stop that is
		// owed (outboxed, held or deferred) holds a later event of the same
		// contact from another source in the same run (row 204c).
		const gate = new Map<string, StopMark[]>()
		const receipts: DrovrEventsDeliverReceipt[] = []
		const refused: DeferredDrovrEvent[] = []
		let backfillDropped = 0
		if (backfill.length > 0) {
			// A drovr rollback turns AIH_DROVR_PROFILE_SYNC off; backfill pages
			// still queued (or retrying) must not reach old drovr code, which
			// burns their keys without an event-not-live guard. They are
			// dropped, not held, so nothing lands in the window: the backfill
			// is idempotent and re-runs once drovr is back. Their own step ids
			// keep them out of the other sources' chunks.
			if (!parseDrovrProfileSyncConfig(process.env).enabled) {
				await log.warn('drovr.contact_sync.backfill_dropped', {
					count: backfill.length,
					reason: 'AIH_DROVR_PROFILE_SYNC is off; re-run the backfill',
				})
				backfillDropped = backfill.length
			} else {
				// Contract §4: refusals go to the straggler retry, unchanged and
				// under their keys; cold-start at once (the retry births the
				// actor and pushes again), event-not-live after drovr's daily
				// pass.
				const backfillStep = withStepPrefix(step, 'contact-sync-backfill:')
				receipts.push(
					await deliverBulk(backfill, backfillStep, context, {
						deferNotLive: true,
						refused,
						gate,
					}),
				)
				if (refused.length > 0) {
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
						...(notLive.length > 0
							? [contactSyncRetryRequest(notLive, 1, at)]
							: []),
						...(coldStart.length > 0
							? [{ ...contactSyncRetryRequest(coldStart, 1, at), ts: at }]
							: []),
					])
				}
			}
		}
		if (others.length > 0 || backfill.length === 0)
			receipts.push(await deliverBulk(others, step, context, { gate }))
		const combined =
			receipts.length === 1 ? receipts[0]! : combineReceipts(receipts)
		return {
			...combined,
			...(backfillDropped > 0 ? { backfillDropped } : {}),
			...(refused.length > 0 ? { deferred: refused.length } : {}),
		}
	},
)
