import { createHash, randomUUID } from 'node:crypto'
import { BulkPaceYieldError } from '@/lib/subscriber-marketing/drovr-bulk-permit'
import { BULK_EVENTS_PER_MINUTE, BULK_CLASS_SLOTS } from '@/lib/subscriber-marketing/contact-sync-deltas'
import { BULK_OUTBOX_QUEUE_WAIT_MS, bulkOutboxSource as cappedLaneFor } from '@/lib/subscriber-marketing/contact-sync-bulk'
import { env } from '@/env.mjs'
import {
	BULK_DELIVERY_SOURCES,
	DROVR_EVENTS_DELIVER_BULK_EVENT,
	DROVR_EVENTS_DELIVER_DELTA_EVENT,
	DROVR_EVENTS_DELIVER_RESTATE_EVENT,
	DROVR_EVENTS_DELIVER_INGEST_EVENT,
	deliverEventNameFor,
	type DrovrDeliverEventName,
	DROVR_EVENTS_DELIVER_EVENT,
} from '@/inngest/events/drovr'
import type { DrovrEventsDeliver } from '@/inngest/events/drovr'
import { inngest } from '@/inngest/inngest.server'
import {
	deliverBatchOrThrow,
	deliverOrThrow,
	deliveryStepId,
	isNeverBornOwnerStop,
} from '@/lib/subscriber-marketing/drovr-shadow-delivery'
import {
	isHeldStopRefusal,
	isNeverBornOwnerStopProblem,
	refusalsByAnswer,
} from '@/lib/subscriber-marketing/drovr-stop-verdict'
import type {
	DeferredDrovrEvent,
	DrovrBatchOutcome,
	RefusedDrovrEvent,
} from '@/lib/subscriber-marketing/drovr-shadow-delivery'
import type { DrovrDeliveryOutcome } from '@/lib/subscriber-marketing/drovr-shadow-emitter'
import {
	isValuePathBirth,
	valuePathBulkFreeze,
	type ValuePathBulkFreeze,
} from '@/lib/subscriber-marketing/drovr-bulk-freeze'
import { admitValuePathBirths } from '@/lib/subscriber-marketing/drovr-value-path-birth-admission'
import { readUnsubscribedValuePathContactIds } from '@/lib/subscriber-marketing/drovr-value-path-birth-admission-live'
import { isSendingJourneyBirth } from '@/lib/subscriber-marketing/drovr-birth-clamp'
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
	drovrOutboxDedupeKey,
	type DrovrOutboxEntry,
	type DrovrOutboxSource,
} from '@/lib/subscriber-marketing/drovr-outbox'
import {
	captureDrovrOutboxLive,
	holdDrovrStopsLive,
	openDrovrOutboxStopsLive,
	settleDrovrOutboxLive,
	rejectDrovrOutboxLive,
	drovrOutboxTargetFromEnv,
	type DrovrOutboxOpenStopsFn,
} from '@/lib/subscriber-marketing/drovr-outbox-live'
import { recordOwnerStopRejectionLive } from '@/lib/subscriber-marketing/drovr-owner-stop-rejection-live'
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
import { captureFailedContactSyncRetry, runPacedContactSyncRetry } from './drovr-contact-sync-retry'
import { ownRetryEvents, readRetryDispositionLive, type OwnedRetryEvent } from '@/lib/subscriber-marketing/contact-sync-retry-owned-events'
import { routeContactSyncRetry, retryEventIdentity, retryStepKey } from '@/lib/subscriber-marketing/contact-sync-retry-route'
import { runPacedSend, waitForBulkSlot, type BulkClass } from '@/lib/subscriber-marketing/drovr-bulk-pace'
import { profileVersionForRefresh, readCurrentOfferAfterProfile } from '@/lib/subscriber-marketing/contact-sync-offer-refresh'

export type DrovrEventsDeliverReceipt = {
	ackEvidenceExpired?: import('@/lib/subscriber-marketing/contact-sync-profile-ack-schema').AckEvidenceExpired
	profileAckAwaitingProof?: true
	supersededUnsubscribes?: number
	/** Backfill events drovr refused, handed to the straggler retry. */
	deferred?: number
	/** Backfill events dropped because contact sync was off. */
	backfillDropped?: number
	/**
	 * Value-path births the bulk lane refused inside the 201e freeze
	 * window, with no sign-off (row 201g).
	 */
	valuePathBirthsRefused?: number
	/** Value-path births skipped because AI Hero records an active opt-out. */
	valuePathBirthsSkippedUnsubscribed?: number
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
	runId: string
	recordOwnerStopRejection: typeof recordOwnerStopRejectionLive
	attempt: DrovrSendAttempt
	lane: Extract<DrovrOutboxSource, 'live' | 'bulk' | 'bulkDelta' | 'bulkRestate' | 'bulkIngest' | 'bulkBackfill' | 'bulkEvergreen'>
	clampAt?: number
	capture: DrovrOutboxCaptureFn
	/** The outbox's owed stops for these contacts (row 204b). */
	openStops: DrovrOutboxOpenStopsFn
	/** Marks stops captured on a first failure delivered once a retry lands. */
	settle: DrovrOutboxSettleFn
	/** Holds stops drovr refused with a 4xx, for a human (row 204c). */
	hold: DrovrOutboxHoldFn
	pace?: (id: string, step: DeliverStep) => Promise<number>
	own?: (...args: Parameters<typeof ownRetryEvents>) => Promise<OwnedRetryEvent[] | import('@/lib/subscriber-marketing/contact-sync-profile-ack-schema').AckEvidenceExpired>
	profileAckRef?: import('@/lib/subscriber-marketing/contact-sync-profile-ack-schema').ProfileAckReference
	completeProfileAck?: () => Promise<import('@/lib/subscriber-marketing/contact-sync-profile-ack-completion-live').ProfileAckWorkerCompletion>
	guardProfileAck?: (events: readonly DrovrShadowEvent[]) => Promise<import('@/lib/subscriber-marketing/contact-sync-profile-ack-schema').AckEvidenceExpired | undefined>
	disposition?: (record: OwnedRetryEvent) => Promise<DrovrBatchOutcome | undefined>
	reject?: (entries: readonly DrovrOutboxEntry[], note: string, status: number) => Promise<void>
	afterProfile?: (id: string, event: DrovrShadowEvent, step: DeliverStep) => Promise<void>
}

async function saveOwnerStopRejection(event: DrovrShadowEvent, answer: { httpStatus: number; problem?: unknown }, context: DeliverContext, attempt: number, requestId: string, clampAt: number): Promise<void> {
	const target = drovrOutboxTargetFromEnv()
	const entry = outboxEntryForEvent(event, context.lane, { sentAt: clampAt })
	await context.recordOwnerStopRejection({ target, entry, problem: answer.problem, httpStatus: answer.httpStatus, rejectedAttempt: { runId: context.runId, requestId, stepKey: drovrOutboxDedupeKey(target, entry), attempt }, decidedAt: new Date().toISOString() })
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

/**
 * Row 201g (the hawk, #345 S1): the instant this run clamps its births at,
 * fixed by a memoized step before its first send. Every retry of a
 * delivery step posts the same bytes, and what runs out of retries is
 * outboxed with it (`firstFailedAt`), so the replay posts them too. drovr
 * forwards a request's event to the actor even when its log already holds
 * the key, so a re-clamped retry would fold an `occurredAt` the log does
 * not keep. A run with no sending-journey birth takes no step: nothing in
 * it is clamped, so any instant posts the same bytes.
 */
export const DROVR_CLAMP_INSTANT_STEP = 'drovr-birth-clamp-instant'
const deliveryKeyDigest = (events: readonly DrovrShadowEvent[]) => createHash('sha256').update(JSON.stringify(events.map(retryEventIdentity).sort())).digest('hex')

const drovrClampInstant = async (
	events: readonly DrovrShadowEvent[],
	step: DeliverStep,
): Promise<number> =>
	events.some(isSendingJourneyBirth)
		? ((await step.run(DROVR_CLAMP_INSTANT_STEP, () => Date.now())) as number)
		: Date.now()

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
		const rank = isBirthEvent(event) ? 0 : isStopEvent(event) ? 1 : event.type === 'contact.profile.updated' ? 2 : 3
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
	outcome: { gatedKeys?: string[]; deferred?: DeferredDrovrEvent[]; terminalRejectedIdentities?: string[] },
	stops: readonly DrovrOutboxEntry[],
) => {
	const owed = new Set([
		...(outcome.gatedKeys ?? []),
		...(outcome.deferred ?? []).map(({ event }) => event.idempotencyKey),
	])
	const terminal = new Set(outcome.terminalRejectedIdentities ?? [])
	return stops.filter((stop) => !owed.has(stop.idempotencyKey) && !terminal.has(retryEventIdentity(stop.body as DrovrShadowEvent)))
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
		{ waitingForStop: true },
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

// Memoize the admitted list before chunking: a retry never shifts events
// into another chunk whose send step already completed. No birth, no read.
const admitBirths = async (
	events: readonly DrovrShadowEvent[],
	step: DeliverStep,
) =>
	events.some(isValuePathBirth)
		? await step.run('value-path-birth-admission', () =>
				admitValuePathBirths({
					events,
					read: readUnsubscribedValuePathContactIds,
					info: log.info,
				}),
			)
		: { events: [...events], skipped: 0 }

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
	const admitted = await admitBirths(shadowFiltered.events, step)
	const gate = await holdBehindOpenStops(admitted.events, step, context)
	const events = inDeliveryOrder(gate.events)
	const clampAt = await drovrClampInstant(events, step)

	let accepted = 0
	let rejected = 0
	let ownerStopsNeverBorn = 0
	let supersededUnsubscribes = 0
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
					const requestId = randomUUID()
					const delivered = await deliverOrThrow({
						event: drovrEvent,
						config,
						clampAt,
					})
					if (delivered.status === 'deferred') {
						const saved = await context.capture([outboxEntryForEvent(drovrEvent, context.lane, { sentAt: clampAt })], new Error(delivered.reason), { status: 'deferred', nextAttemptAt: new Date(Date.now() + DROVR_OUTBOX_DEFERRED_STOP_WAIT_MS) })
						if (saved.status !== 'outboxed') throw new Error('DeferredStorage: you retained event-not-live work, and it failed because durable storage is unavailable. Accepted: the unchanged scoped body with explicit deferred status. Fix: restore storage before retrying; do not acknowledge or infer state from prose. Debug: inspect the capture receipt and SDK run.')
						return delivered
					}
					if (delivered.status === 'rejected' && isNeverBornOwnerStop(drovrEvent, delivered)) {
						await saveOwnerStopRejection(drovrEvent, delivered, context, context.attempt.attempt ?? 0, requestId, clampAt)
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
				unsent: () => [
					outboxEntryForEvent(drovrEvent, context.lane, { sentAt: clampAt }),
				],
				capture: context.capture,
				outboxed: () => ({ status: 'outboxed' }),
				early: earlyStops([drovrEvent], context, (outcome) =>
					outcome.status === 'held' || outcome.status === 'deferred' || (outcome.status === 'rejected' && isNeverBornOwnerStop(drovrEvent, outcome))
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
		if (outcome.status === 'outboxed' || outcome.status === 'deferred') {
			outboxed += 1
			if (isStopEvent(drovrEvent)) {
				const list = outboxedStops.get(drovrEvent.contactId) ?? []
				list.push(stopMarkOf(drovrEvent))
				outboxedStops.set(drovrEvent.contactId, list)
			}
			continue
		}
		if (outcome.status === 'superseded') supersededUnsubscribes += 1
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
		...(admitted.skipped > 0
			? { valuePathBirthsSkippedUnsubscribed: admitted.skipped }
			: {}),
		...(ownerStopsNeverBorn > 0 ? { ownerStopsNeverBorn } : {}),
		...(supersededUnsubscribes > 0 ? { supersededUnsubscribes } : {}),
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
	alreadyDelivered?: boolean
	terminalRejectedIdentities?: string[]
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
	// Fresh before fanout/capture, even if an earlier SDK read succeeded.
	const expired = await context.guardProfileAck?.(batch)
	if (expired) return { status: 'skipped', accepted: 0, rejected: 0, discarded: 0, reason: 'AckEvidenceExpired', ackEvidenceExpired: expired }
	const fanOutEvents = context.guardProfileAck && batch.every(event => event.type === 'contact.profile.updated' || event.type === 'contact.links.issued')
		? batch // Frozen first-owned wire members never re-read mutable ownership.
		: await fanOut(batch, step, context)
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
	const admitted = await admitBirths(shadowFiltered.events, step)
	const clampAt = context.clampAt ?? await drovrClampInstant(admitted.events, step)
	let owned: OwnedRetryEvent[] = []
	if (context.pace && admitted.events.length) {
		if (!context.own) throw new Error('BulkOwnership: you prepared capped work, and it failed because its immutable ownership port is unavailable. Accepted: every normalized event retained and reread before booking. Fix: restore the ownership adapter. Debug: inspect the capped context.')
		const ownership = await step.run(`own-paced-input:${deliveryKeyDigest(admitted.events)}`, () => context.own!(admitted.events, context.lane, clampAt)) as OwnedRetryEvent[] | import('@/lib/subscriber-marketing/contact-sync-profile-ack-schema').AckEvidenceExpired
		if (!Array.isArray(ownership)) return { status: 'skipped', accepted: 0, rejected: 0, discarded, reason: 'AckEvidenceExpired', ackEvidenceExpired: ownership }
		owned = ownership
	}
	const retained = context.pace ? owned.map(record => record.event) : admitted.events
	// Gate FIRST retained planned times, not a newer duplicate's timestamp.
	const gate = await holdBehindOpenStops(retained, step, context)
	const events = inDeliveryOrder(gate.events)
	const ownedByIdentity = new Map(owned.map(record => [retryEventIdentity(record.event), record]))
	const ownedClocks = new Map(owned.map(record => [retryEventIdentity(record.event), record.clampAt]))

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
	let supersededUnsubscribes = 0
	let retainedHeld = 0
	let retainedRejected = 0
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
			chunkIndex < tenantEvents.length;
			chunkIndex += 1
		) {
			const sliced = tenantEvents.slice(chunkIndex, chunkIndex + 1)
			const chunk = sliced.filter((event) => !isBehind(event, outboxedStops))
			late.push(...sliced.filter((event) => isBehind(event, outboxedStops)))
			if (chunk.length === 0) continue
			// A chunk that runs out of retries goes to the outbox whole:
			// drovr dedupes the items that did land when the replay re-posts.
			// `by-time:` since the chunks follow time order (row 204b): a run
			// in flight across that deploy re-posts its chunks, which drovr
			// dedupes, instead of replaying a memoized chunk that now holds
			// other events.
			// New ids are deliberate: in-flight old chunks must not be replayed
			// as if their single-event replacement had already completed.
			const stepId = `paced-single:${tenantId}:${deliveryKeyDigest(chunk)}`
			const sendClampAt = ownedClocks.get(retryEventIdentity(chunk[0]!)) ?? clampAt
			const entries = chunk.map(event => outboxEntryForEvent(event, context.lane))
			const record = ownedByIdentity.get(retryEventIdentity(chunk[0]!))
			if (context.pace && (!record || !context.disposition)) throw new Error('BulkDisposition: you resumed capped delivery, and it failed because its scoped disposition port is unavailable. Accepted: retained state checked before booking and at POST. Fix: restore the ownership and disposition adapters. Debug: inspect the full scoped key.')
			const disposition = async (): Promise<DrovrBatchOutcome | undefined> => {
				const expired = await context.guardProfileAck?.(chunk)
				if (expired) return { accepted: 0, rejected: 0, ackEvidenceExpired: expired }
				return record && context.disposition ? context.disposition(record) : undefined
			}
			const retained = await step.run(`${stepId}:disposition`, disposition)
			if (retained?.ackEvidenceExpired) return { status: 'skipped', accepted, rejected, discarded, reason: 'AckEvidenceExpired', ackEvidenceExpired: retained.ackEvidenceExpired }
			if (retained?.alreadyDelivered) {
				if (chunk[0]!.type === 'contact.profile.updated') await context.afterProfile?.(stepId, chunk[0]!, step)
				if (context.profileAckRef) {
					const completion = await step.run(`${stepId}:settle-retained-profile-ack`, () => context.completeProfileAck!()) as import('@/lib/subscriber-marketing/contact-sync-profile-ack-completion-live').ProfileAckWorkerCompletion
					const expired = await context.guardProfileAck?.(chunk) ?? (completion?._tag === 'AckEvidenceExpired' ? completion : undefined)
					if (expired) return { status: 'skipped', accepted, rejected, discarded, reason: 'AckEvidenceExpired', ackEvidenceExpired: expired }
					if (completion?._tag === 'ProfileAckAwaitingProof') return { status: 'delivered', accepted, rejected, discarded, profileAckAwaitingProof: true }
				}
				continue
			}
			const expiredBeforeBooking = await context.guardProfileAck?.(chunk)
			if (expiredBeforeBooking) return { status: 'skipped', accepted, rejected, discarded, reason: 'AckEvidenceExpired', ackEvidenceExpired: expiredBeforeBooking }
			const postNative = (sendAttempt: number) => sendOrOutbox<ChunkOutcome & Partial<Outboxed>>({
					attempt: { ...context.attempt, attempt: sendAttempt },
					send: async () => {
						// A replay may finish while a reservation sleeps. Re-read at
						// POST time rather than trusting the memoized fast path.
						const retained = await disposition()
						if (retained) return retained
						const requestId = randomUUID()
						const answer = await deliverBatchOrThrow(
							options.deferNotLive
								? { events: chunk, config, clampAt: sendClampAt, deferNotLive: true }
								: { events: chunk, config, clampAt: sendClampAt },
						)
						const { refused = [], ...counts } = answer
						const terminalRejectedIdentities: string[] = []
						for (const refusal of refused.filter(item => isNeverBornOwnerStopProblem(item.event, item.problem))) {
							const selected = chunk.find(event => retryEventIdentity(event) === retryEventIdentity(refusal.event) && event.type === refusal.event.type && event.occurredAt === refusal.event.occurredAt)
							if (!selected) throw new Error('OwnerStopRejection: you saved a batch refusal, and it failed because its owner scope was not posted by this attempt. Accepted: an exact first-owned selected member. Fix: retain its gate and inspect the response adapter. Debug: inspect the SDK attempt and full scoped identity.')
							await saveOwnerStopRejection(selected, refusal, context, sendAttempt, requestId, sendClampAt)
							terminalRejectedIdentities.push(retryEventIdentity(selected))
						}
						for (const refusal of refused.filter(item => !isStopEvent(item.event))) await context.reject?.([outboxEntryForEvent(refusal.event, context.lane)], refusalReason(refusal.httpStatus, refusal.problem), refusal.httpStatus)
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
						const deferredStops = (counts.deferred ?? []).filter(({ reason }) => reason === 'event-not-live')
						let deferredGated = 0
						if (deferredStops.length > 0) {
							const captured = await context.capture(
								deferredStops.map(({ event }) =>
									outboxEntryForEvent(event, context.lane),
								),
								new Error(
									'EventNotLive: you sent an event, and it failed because this contact is not migrated. Accepted: the same immutable event later. Fix: retain deferred status for the straggler retry. Debug: inspect its scoped receipt.',
								),
								{
									status: 'deferred',
									nextAttemptAt: new Date(
										Date.now() + DROVR_OUTBOX_DEFERRED_STOP_WAIT_MS,
									),
								},
							)
							if (captured.status !== 'outboxed') throw new Error('DeferredStorage: you retained event-not-live work, and it failed because durable storage is unavailable. Accepted: the unchanged scoped body with explicit deferred status. Fix: restore storage and retry without acknowledging. Debug: inspect the capture receipt and SDK run.')
							if (captured.status === 'outboxed') {
								deferredGated = deferredStops.filter(({ event }) => isStopEvent(event)).length
								gatedKeys.push(
									...deferredStops.map(({ event }) => event.idempotencyKey),
								)
							}
						}
						return {
							...counts,
							...(terminalRejectedIdentities.length ? { terminalRejectedIdentities } : {}),
							rejected: counts.rejected - held,
							...(held > 0 ? { heldStops: held } : {}),
							...(deferredGated > 0
								? { deferredStopsGated: deferredGated }
								: {}),
							...(gatedKeys.length > 0 ? { gatedKeys } : {}),
						}
					},
					unsent: () =>
						chunk.map((event) =>
							outboxEntryForEvent(event, context.lane, { sentAt: sendClampAt }),
						),
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
				})
			const post = async (sendAttempt: number) => {
				try { return await postNative(sendAttempt) }
				catch (error) {
					const expired = await context.guardProfileAck?.(chunk)
					if (expired) return { accepted: 0, rejected: 0, ackEvidenceExpired: expired }
					throw error
				}
			}
			const outcome = (retained ?? (context.pace ? await runPacedSend(step, stepId, (id) => context.pace!(id, step), post, context.attempt.attempt) : await step.run(stepId, () => post(context.attempt.attempt)))) as ChunkOutcome & Partial<Outboxed>
			if (outcome.ackEvidenceExpired) return { status: 'skipped', accepted, rejected, discarded, reason: 'AckEvidenceExpired', ackEvidenceExpired: outcome.ackEvidenceExpired }
			// Every pre-captured fact, not just retried stops, is settled by key.
			// Deferred or outboxed events stay pending for their existing owner.
			if ((outcome.accepted > 0 || outcome.alreadyDelivered) && !outcome.outboxed && !(outcome.deferred?.length)) {
				// Do not retire the profile's durable work before its derived
				// refresh command is itself durable. A failed publish must replay.
				if (chunk[0]!.type === 'contact.profile.updated') await context.afterProfile?.(stepId, chunk[0]!, step)
				const note = outcome.rejected > 0 ? `settled by an Inngest retry: its chunk was answered, and drovr refused ${outcome.rejected} item(s) that are not stops (or never born there), final and counted rejected` : DROVR_SETTLED_BY_RETRY
				const proof = chunk.some(event => event.type === 'contact.profile.updated' || event.type === 'contact.links.issued') ? { receiverAccepted: outcome.rejected === 0, ...(context.profileAckRef ? { profileAckRef: context.profileAckRef } : {}) } : undefined
				const completion = await step.run(`${stepId}:settle`, () => proof ? context.settle(entries, note, proof) : context.settle(entries, note)) as import('@/lib/subscriber-marketing/contact-sync-profile-ack-completion-live').ProfileAckWorkerCompletion
				const expired = await context.guardProfileAck?.(chunk) ?? (completion?._tag === 'AckEvidenceExpired' ? completion : undefined)
				if (expired) return { status: 'delivered', accepted: accepted + outcome.accepted, rejected: rejected + outcome.rejected, discarded, reason: 'AckEvidenceExpired', ackEvidenceExpired: expired }
				if (completion?._tag === 'ProfileAckAwaitingProof') return { status: 'delivered', accepted: accepted + outcome.accepted, rejected: rejected + outcome.rejected, discarded, profileAckAwaitingProof: true }
			}
			supersededUnsubscribes += outcome.supersededUnsubscribes ?? 0
			retainedHeld += outcome.retainedHeld ?? 0
			retainedRejected += outcome.retainedRejected ?? 0
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
		...(supersededUnsubscribes > 0 ? { supersededUnsubscribes } : {}),
		...(retainedHeld > 0 ? { retainedHeld } : {}),
		...(retainedRejected > 0 ? { retainedRejected } : {}),
		...(admitted.skipped > 0
			? { valuePathBirthsSkippedUnsubscribed: admitted.skipped }
			: {}),
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
	async ({ event, step, attempt, maxAttempts, runId }) => {
		// Drain pre-deploy events under the same function id, without posting
		// a bulk payload on the live lane or dropping its queued bytes.
		if (BULK_DELIVERY_SOURCES.has(event.data.source)) {
			await step.sendEvent('drain-to-bulk', { name: deliverEventNameFor(event.data.source), data: event.data })
			return { status: 'skipped', reason: 'forwarded-to-capped-worker', accepted: 0, rejected: 0, discarded: 0 }
		}
		return deliverBatch(event.data.events, step, {
			runId,
			recordOwnerStopRejection: recordOwnerStopRejectionLive,
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
	forcedLane?: DeliverContext['lane'],
): Promise<void> {
	// A frozen request already owns native debt. Failure never recreates it
	// from an old SDK body after retention or privacy cleanup.
	if (data.profileAckRef) return
	const capped = BULK_DELIVERY_SOURCES.has(data.source)
	const entries = ownerReadUnsent(data.events, forcedLane ?? (capped ? cappedLaneFor(data.source) : 'live')).map(entry => ({ ...entry, ...(data.firstFailedAt && Number.isFinite(Date.parse(data.firstFailedAt)) ? { firstSentAt: data.firstFailedAt } : {}) }))
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
		sleepUntil: (id: string, date: Date) => step.sleepUntil(`${prefix}${id}`, date),
	}) as DeliverStep

const combineReceipts = (
	receipts: DrovrEventsDeliverReceipt[],
): DrovrEventsDeliverReceipt => {
	const delivered = receipts.filter((receipt) => receipt.status === 'delivered')
	if (receipts.length > 0 && delivered.length === 0) return receipts[0]!
	const sumOf = (
		field:
			| 'outboxed'
			| 'heldBehindStop'
			| 'heldStops'
			| 'deferredStopsGated'
			| 'supersededUnsubscribes'
			| 'valuePathBirthsSkippedUnsubscribed',
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
		...sumOf('supersededUnsubscribes'),
		...sumOf('valuePathBirthsSkippedUnsubscribed'),
		...(receipts.some(receipt => receipt.ackEvidenceExpired) ? { reason: 'AckEvidenceExpired', ackEvidenceExpired: receipts.find(receipt => receipt.ackEvidenceExpired)!.ackEvidenceExpired } : {}),
		...(receipts.some(receipt => receipt.profileAckAwaitingProof) ? { profileAckAwaitingProof: true as const } : {}),
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
export const BULK_DELIVERY_BATCH = { maxSize: 1, timeout: '1s' } as const

/** Envelope scheduling is not the event cap: an envelope may contain many
 * events and fan-out adds copies. The shared database reservation immediately
 * before each single-event POST enforces BULK_EVENTS_PER_MINUTE, including
 * retries/replay. The sleep keeps ordinary operation off the retry ladder.
 */
const classThrottle = (kind: BulkClass) => ({ limit: 1, period: `${Math.ceil(60 * Object.values(BULK_CLASS_SLOTS).reduce<number>((sum, value) => sum + value, 0) / (BULK_EVENTS_PER_MINUTE * BULK_CLASS_SLOTS[kind]))}s` as `${number}s` })
export const BULK_DELIVERY_THROTTLE = classThrottle('backfill')

const cappedWorker = (id: string, eventName: DrovrDeliverEventName, kind: BulkClass) => inngest.createFunction(
	{
		id,
		name: 'drovr: deliver bulk events durably',
		retries: DROVR_SEND_RETRIES,
		concurrency: [{ limit: 4 }],
		batchEvents: BULK_DELIVERY_BATCH,
		throttle: classThrottle(kind),
		onFailure: async ({ event, error }) => { const data = event.data.event.data; if (data.stragglerRetry) await captureFailedContactSyncRetry({ ...data.stragglerRetry, deliverySource: BULK_DELIVERY_SOURCES.has(data.source) ? data.source : 'evergreen-pitch-backfill' }, error); else await outboxFailedRun(data, error, captureDrovrOutboxLive, cappedLaneFor(data.source)) },
	},
	{ event: eventName },
	async ({ events, step, runId }) => {
		// A legacy/unknown source on a capped trigger never becomes live on
		// a class route, a capacity handoff or the next replay.
		for (const envelope of events) if (!BULK_DELIVERY_SOURCES.has(envelope.data.source)) envelope.data.source = 'evergreen-pitch-backfill'
		let firstFailedAt = events[0]?.data.firstFailedAt
		try {
		// Every raw parent stop is owed BEFORE any child can run. A stop
		// listed last must gate an earlier-listed positive child as well.
		// A disabled profile-backfill child is discarded, not made a gate.
		const rawStops = events.flatMap(envelope => envelope.data.source === 'contact-sync-backfill' && !parseDrovrProfileSyncConfig(process.env).enabled ? [] : withoutSyntheticContacts(envelope.data.events).kept.filter(isStopEvent).map(item => ({ item, source: cappedLaneFor(envelope.data.source), at: envelope.data.firstFailedAt })))
		if (rawStops.length) {
			const capturedAt = await step.run('raw-parent-stop-clock', async () => Date.now()) as number
			await step.run(`capture-raw-parent-stops:${deliveryKeyDigest(rawStops.map(record => record.item))}`, async () => {
				const entries = rawStops.map(record => {
					const at = record.at === undefined ? capturedAt : Date.parse(record.at)
					if (!Number.isFinite(at)) throw new Error('ParentStopClock: you admitted parent stops, and it failed because the original clock is invalid. Accepted: the original finite UTC instant. Fix: restore the parent metadata. Debug: inspect firstFailedAt without moving its clock.')
					return outboxEntryForEvent(record.item, record.source, { needsFanOut: true, sentAt: at })
				})
				const capture = await captureDrovrOutboxLive(entries, undefined, { nextAttemptAt: new Date(Date.now() + BULK_OUTBOX_QUEUE_WAIT_MS) })
				if (capture.status !== 'outboxed') throw new Error('ParentStops: you split capped work, and it failed because its raw stops are not durably owned. Accepted: every owed parent stop retained before child publication. Fix: restore the outbox and retry the parent unchanged. Debug: inspect the parent capture receipt.')
				return entries.length
			})
		}
		// Bound the worst-case durable retry step count, including owner copies.
		// One input leaves room for cold birth, redelivery and every bounded
		// retry/expiry booking. Legacy SDK batches also retain retry metadata.
		if (events.length > 1 || events.reduce((count, envelope) => count + envelope.data.events.length, 0) > 1) {
			const shards = events.flatMap(envelope => {
				const chunks = envelope.data.stragglerRetry || envelope.data.offerRefresh || !envelope.data.events.length ? [envelope.data.events] : envelope.data.events.map(item => [item])
				return chunks.map(chunk => { const data = { ...envelope.data, events: chunk }; if (chunk.length && !chunk.some(item => item.type === 'contact.profile.updated' || item.type === 'contact.links.issued') && !data.stragglerRetry) { delete data.profileAckRef; delete data.profileAckNativeDebt } return { id: `paced-shard:${createHash('sha256').update(JSON.stringify(data)).digest('hex')}`, name: eventName, data } })
			})
			for (let offset = 0; offset < shards.length; offset += 100) await step.sendEvent(`bounded-paced-shards:${createHash('sha256').update(JSON.stringify(shards.slice(offset, offset + 100).map(shard => shard.id))).digest('hex')}`, shards.slice(offset, offset + 100))
			return { status: 'skipped', reason: 'forwarded-to-bounded-capped-shards', accepted: 0, rejected: 0, discarded: 0 }
		}
		// Old bulk envelopes still drain, while new sources have separate queues.
		const actualKind = events.some(item => item.data.source === 'contact-profile-sync') ? 'delta' : events.some(item => item.data.source === 'contact-profile-restate') ? 'restate' : events.some(item => item.data.source === 'kit-directory-ingest') ? 'ingest' : 'backfill'
		const source = BULK_DELIVERY_SOURCES.has(events[0]!.data.source) ? events[0]!.data.source : 'evergreen-pitch-backfill'
		if (actualKind !== kind) {
			await step.sendEvent('route-to-class-queue', events.map(envelope => ({ name: deliverEventNameFor(BULK_DELIVERY_SOURCES.has(envelope.data.source) ? envelope.data.source : 'evergreen-pitch-backfill'), data: envelope.data })))
			return { status: 'skipped', reason: 'forwarded-to-class-queue', accepted: 0, rejected: 0, discarded: 0 }
		}
		if (events[0]!.data.stragglerRetry) return await runPacedContactSyncRetry({ event: { data: { ...events[0]!.data.stragglerRetry, paceClass: actualKind, deliverySource: source, firstFailedAt: firstFailedAt ?? events[0]!.data.stragglerRetry.firstFailedAt } }, step, runId })
		for (const envelope of events) {
			if (envelope.data.offerRefresh) envelope.data.events = await step.run(`refresh-current-offer:${envelope.data.offerRefresh.contactId}:${envelope.data.offerRefresh.profileVersion}`, () => readCurrentOfferAfterProfile(envelope.data.offerRefresh!)) as DrovrShadowEvent[]
		}
		const originalClamp = firstFailedAt === undefined ? await drovrClampInstant(events.flatMap(envelope => envelope.data.events), step) : Date.parse(firstFailedAt)
		if (!Number.isFinite(originalClamp)) throw new Error('BirthClamp: you resumed delivery, and it failed because the original clamp instant is invalid. Accepted: an ISO timestamp. Fix: restore the original replay metadata. Debug: inspect firstFailedAt.')
		firstFailedAt = new Date(originalClamp).toISOString()
		const profileAckRef = events[0]?.data.events.some(item => item.type === 'contact.profile.updated' || item.type === 'contact.links.issued') ? events[0]?.data.profileAckRef : undefined
		const context: DeliverContext = {
			runId,
			recordOwnerStopRejection: recordOwnerStopRejectionLive,
			attempt: { attempt: 0, maxAttempts: DROVR_SEND_RETRIES + 1 },
			lane: cappedLaneFor(events[0]!.data.source),
			clampAt: originalClamp,
			pace: (id, tools) => waitForBulkSlot(tools, id, actualKind),
			profileAckRef,
			completeProfileAck: profileAckRef ? async () => {
				const { completeProfileAckWorkerReferenceLive } = await import('@/lib/subscriber-marketing/contact-sync-profile-ack-completion-live')
				return completeProfileAckWorkerReferenceLive(profileAckRef!)
			} : undefined,
			own: profileAckRef ? async (input, lane, at) => {
				try { return await ownRetryEvents(input, lane, at, { retainedOnly: true }) }
				catch (error) {
					const expired = await context.guardProfileAck?.(input)
					if (expired) return expired
					throw error
				}
			} : ownRetryEvents,
			guardProfileAck: profileAckRef ? async input => {
				const { guardProfileAckWorkerAdmissionLive } = await import('@/lib/subscriber-marketing/contact-sync-profile-ack-admission')
				return guardProfileAckWorkerAdmissionLive(profileAckRef!, input, events[0]!.data.profileAckNativeDebt === true)
			} : undefined,
			disposition: record => readRetryDispositionLive(record, { gates: false }),
			reject: rejectDrovrOutboxLive,
			afterProfile: async (id, event, tools) => {
				if (event.idempotencyKey.includes(':restate:')) return
				await tools.sendEvent(`${id}:refresh-offer`, { id: `offer-refresh:${retryStepKey(event)}`, name: eventName, data: { source, events: [], offerRefresh: { contactId: event.contactId, profileVersion: profileVersionForRefresh(event) } } })
			},
			capture: profileAckRef ? async entries => {
				const expired = await context.guardProfileAck?.(entries.map(entry => entry.body as DrovrShadowEvent))
				return expired ? { status: 'unavailable' } : { status: 'outboxed', count: entries.length }
			} : captureDrovrOutboxLive,
			openStops: openDrovrOutboxStopsLive,
			settle: settleDrovrOutboxLive,
			hold: holdDrovrStopsLive,
		}
		const isBackfill = (bulkEvent: (typeof events)[number]) =>
			bulkEvent.data.source === 'contact-sync-backfill'
		// Row 201g: inside the 201e window a value-path birth never rides the
		// bulk lane without the hawk's sign-off. Decided once per run, so a
		// retry keeps the same chunks.
		// Its lines are logged inside the step, so a run logs them once, not
		// once per step its handler replays through.
		const valuePathBirths = events
			.flatMap((bulkEvent) => bulkEvent.data.events)
			.filter(isValuePathBirth)
		const freeze = (await step.run('value-path-bulk-freeze', async () => {
			const decided = valuePathBulkFreeze(process.env, Date.now())
			if (valuePathBirths.length > 0) {
				if (decided.frozen)
					await log.error('drovr.bulk.value_path_births_refused', {
						count: valuePathBirths.length,
						reason: decided.reason,
						idempotencyKeys: valuePathBirths
							.slice(0, 20)
							.map((event) => event.idempotencyKey),
					})
				else if (decided.signedOffBy)
					await log.warn('drovr.bulk.value_path_births_signed_off', {
						count: valuePathBirths.length,
						signedOffBy: decided.signedOffBy,
					})
			}
			return decided
		})) as ValuePathBulkFreeze
		const admitted = (list: DrovrShadowEvent[]) =>
			freeze.frozen ? list.filter((event) => !isValuePathBirth(event)) : list
		const others = admitted(
			events
				.filter((bulkEvent) => !isBackfill(bulkEvent))
				.flatMap((bulkEvent) => bulkEvent.data.events),
		)
		const backfill = admitted(
			events.filter(isBackfill).flatMap((bulkEvent) => bulkEvent.data.events),
		)
		const valuePathBirthsRefused = freeze.frozen ? valuePathBirths.length : 0
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
							? [routeContactSyncRetry(contactSyncRetryRequest(notLive, 1, at, undefined, actualKind, firstFailedAt, source, events[0]?.data.profileAckRef, events[0]?.data.profileAckNativeDebt))]
							: []),
						...(coldStart.length > 0
							? [{ ...routeContactSyncRetry(contactSyncRetryRequest(coldStart, 1, at, undefined, actualKind, firstFailedAt, source, events[0]?.data.profileAckRef, events[0]?.data.profileAckNativeDebt)), ts: at }]
							: []),
					])
				}
			}
		}
		if (others.length > 0 || backfill.length === 0) {
			const profileSync = events.some((event) => event.data.source === 'contact-profile-sync' || event.data.source === 'contact-profile-restate')
			const profileRefused: DeferredDrovrEvent[] = []
			receipts.push(await deliverBulk(others, step, context, { gate, ...(profileSync ? { deferNotLive: true, refused: profileRefused } : {}) }))
			if (profileRefused.length > 0) {
				const at = (await step.run('profile-sync:defer-at', () => Date.now())) as number
				await step.sendEvent('profile-sync:defer-refused', routeContactSyncRetry(contactSyncRetryRequest(profileRefused, 1, at, undefined, actualKind, firstFailedAt, source, events[0]?.data.profileAckRef, events[0]?.data.profileAckNativeDebt)))
				refused.push(...profileRefused)
			}
		}
		const combined =
			receipts.length === 1 ? receipts[0]! : combineReceipts(receipts)
		return {
			...combined,
			...(backfillDropped > 0 ? { backfillDropped } : {}),
			...(refused.length > 0 ? { deferred: refused.length } : {}),
			...(valuePathBirthsRefused > 0 ? { valuePathBirthsRefused } : {}),
		}
		} catch (error) {
			if (!(error instanceof BulkPaceYieldError)) throw error
			const at = await step.run('capacity-handoff-at', async () => Date.now() + 60_000) as number
			await step.sleepUntil('capacity-handoff-wait', new Date(at))
			await step.sendEvent('capacity-handoff', events.map(envelope => ({ id: `paced-handoff:${runId}:${deliveryKeyDigest(envelope.data.events)}`, name: deliverEventNameFor(envelope.data.source), data: { ...envelope.data, ...(firstFailedAt ? { firstFailedAt } : {}) } })))
			return { status: 'skipped', reason: 'queued-for-paced-capacity', accepted: 0, rejected: 0, discarded: 0 }
		}
	},
)

// Preserve the old bulk id/event for queued commands. New priorities cannot
// sit behind that backlog: each owns its queue, but shares one reservation row.
export const drovrEventsDeliverBulk = cappedWorker('drovr-events-deliver-bulk-v1', DROVR_EVENTS_DELIVER_BULK_EVENT, 'backfill')
export const drovrEventsDeliverDelta = cappedWorker('drovr-events-deliver-delta-v1', DROVR_EVENTS_DELIVER_DELTA_EVENT, 'delta')
export const drovrEventsDeliverRestate = cappedWorker('drovr-events-deliver-restate-v1', DROVR_EVENTS_DELIVER_RESTATE_EVENT, 'restate')
export const drovrEventsDeliverIngest = cappedWorker('drovr-events-deliver-ingest-v1', DROVR_EVENTS_DELIVER_INGEST_EVENT, 'ingest')
