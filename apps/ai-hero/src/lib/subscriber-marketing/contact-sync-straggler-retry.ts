import { createHash } from 'node:crypto'
import type { BulkClass } from './drovr-bulk-pace'
import { isUncappedOfferRetry, retryStepKey, routeContactSyncRetry } from './contact-sync-retry-route'

import {
	CONTACT_SYNC_RETRY_EVENT,
	type DrovrContactSyncRetryRequested,
} from '@/inngest/events/drovr'

import { parseDrovrProfileSyncConfig } from './drovr-contact-profile-sync-requests'
import type {
	DeferredDrovrEvent,
	DrovrBatchOutcome,
} from './drovr-shadow-delivery'
import {
	mapDrovrShadowFact,
	type DrovrShadowEvent,
} from './drovr-shadow-emitter'
import type { ContactRecord } from './types'
import { HeldBatchContinuationError } from './contact-sync-held-batch'

export { CONTACT_SYNC_RETRY_EVENT }

/**
 * The contact-sync push contract (§4, revised 2026-09-27): an event drovr
 * refused as event-not-live (or cold-start-unhandled) recorded nothing and
 * left its key unconsumed. It is re-sent unchanged, same key, 1 h after the
 * refusal and then every 2 h, matching drovr's 2-hourly straggler pass
 * (worst case ~4 h). Never dropped, never re-keyed.
 */
export function stragglerRetryDelayMs(attempt: number): number {
	return (attempt <= 1 ? 1 : 2) * 60 * 60 * 1000
}

/** About a day of refusals (1 h + 11 × 2 h) is worth a look. */
export const STRAGGLER_STUCK_AFTER_ATTEMPTS = 12

/**
 * The request is keyed by its events and attempt: Inngest drops a send
 * whose id it saw within 24 h. A late joiner re-pushes its unchanged
 * version (same keys) on every change until drovr migrates it, so this
 * holds one pending retry per contact instead of one per change. The
 * retry's own next attempt is a new id, and so is any changed content.
 */
export type RetryAcknowledgement = NonNullable<
	DrovrContactSyncRetryRequested['data']['acknowledge']
>

export function contactSyncRetryRequest(
	items: DeferredDrovrEvent[],
	attempt: number,
	nowMs: number,
	acknowledge?: RetryAcknowledgement,
	paceClass?: BulkClass,
	firstFailedAt?: string,
	deliverySource?: DrovrContactSyncRetryRequested['data']['deliverySource'],
): DrovrContactSyncRetryRequested & { id: string; ts: number } {
	const keys = items.map(({ event }) => JSON.stringify([event.tenantId, event.contactId, event.journeyId, event.idempotencyKey])).sort()
	const digest = createHash('sha256').update(JSON.stringify([paceClass ?? 'live', deliverySource ?? null, acknowledge ?? null, keys])).digest('hex')
	return {
		name: CONTACT_SYNC_RETRY_EVENT,
		id: `contact-sync-retry:${attempt}:${digest}`,
		ts: nowMs + stragglerRetryDelayMs(attempt),
		data: { items, attempt, firstFailedAt: firstFailedAt ?? new Date(nowMs).toISOString(), ...(acknowledge ? { acknowledge } : {}), ...(paceClass ? { paceClass } : {}), ...(deliverySource ? { deliverySource } : {}) },
	}
}

/**
 * The directory birth for a contact drovr has no directory actor for
 * (contract §4, after a 409 cold-start-unhandled): the live feed's own
 * `contact-created` mapping, so shape and key (`directory:seed:<id>`) match
 * the seed and the feed exactly. drovr births an actor only once whatever
 * the key, so it can never double-birth.
 */
export function directoryBirthEvents(args: {
	contact: ContactRecord
	kitSubscriberId?: string
}): DrovrShadowEvent[] {
	return mapDrovrShadowFact({
		kind: 'contact-created',
		contactId: args.contact.id,
		createdAt: args.contact.createdAt,
		sourceLifecycle: args.contact.lifecycle,
		...(args.kitSubscriberId ? { kitSubscriberId: args.kitSubscriberId } : {}),
	})
}

/** The `birth` port: reads each contact and delivers their births together. */
export function createDirectoryBirth(args: {
	findContactById(id: string): Promise<ContactRecord | null | undefined>
	kitSubscriberIdFor(contactId: string): Promise<string | undefined>
	/** Default delivery mode: a failure throws and the step retries. */
	deliver(events: DrovrShadowEvent[]): Promise<unknown>
}): (contactIds: string[]) => Promise<void> {
	return async (contactIds) => {
		const births: DrovrShadowEvent[] = []
		for (const contactId of contactIds) {
			const contact = await args.findContactById(contactId)
			if (!contact) continue
			births.push(
				...directoryBirthEvents({
					contact,
					kitSubscriberId: await args.kitSubscriberIdFor(contactId),
				}),
			)
		}
		if (births.length > 0) await args.deliver(births)
	}
}

/**
 * Refusals as cold-start-unhandled get their contacts' directory actors
 * born, then the same events once more: a birth lands on v2, so the push
 * lands straight away. Never for event-not-live, whose actor exists on v1.
 * Returns what is still refused, for the daily retry.
 */
type BirthRedeliveryOutcome = DrovrBatchOutcome & { deferred: DeferredDrovrEvent[] } & (
	| { kind: 'resolved' }
	| { kind: 'held'; anchor: DrovrShadowEvent; reason: 'outboxed' | 'unproven-delivery' }
)
export async function birthThenRedeliver(args: {
	deferred: DeferredDrovrEvent[]
	pacedDeliver?: (id: string, events: DrovrShadowEvent[]) => Promise<DrovrBatchOutcome>
	pacedBirth?: (id: string, contacts: string[]) => Promise<void | DrovrBatchOutcome>
	afterProfile?: (event: DrovrShadowEvent) => Promise<void>
	step: RetryStep
	birth: (contactIds: string[]) => Promise<void>
	deliver: (events: DrovrShadowEvent[]) => Promise<DrovrBatchOutcome>
}): Promise<BirthRedeliveryOutcome> {
	const cold = args.deferred.filter(
		(item) => item.reason === 'cold-start-unhandled',
	)
	if (cold.length === 0)
		return { kind: 'resolved', deferred: args.deferred, accepted: 0, rejected: 0 }
	const result: DrovrBatchOutcome & { kind: 'resolved'; deferred: DeferredDrovrEvent[] } = { kind: 'resolved', deferred: args.deferred.filter((item) => item.reason !== 'cold-start-unhandled'), accepted: 0, rejected: 0 }
	const born = new Set<string>()
	for (const { event } of cold) {
		if (!born.has(event.contactId)) {
			const birthId = `paced-birth:${createHash('sha256').update(event.contactId).digest('hex')}`
			const directory = args.pacedBirth ? await args.pacedBirth(birthId, [event.contactId]) : await args.step.run(birthId, () => args.birth([event.contactId])) as void | DrovrBatchOutcome
			if (directory && (retryAnswerNeedsHold(directory) || directory.rejected > 0 || (directory.retainedRejected ?? 0) > 0 || directory.deferred?.length)) return { ...result, kind: 'held', anchor: event, reason: directory.outboxed ? 'outboxed' : 'unproven-delivery', deferred: args.deferred }
			born.add(event.contactId)
		}
		const id = `paced-redeliver:${retryStepKey(event)}`
		const answer = args.pacedDeliver ? await args.pacedDeliver(id, [event]) : (await args.step.run(id, () => args.deliver([event]))) as DrovrBatchOutcome
		if (retryAnswerNeedsHold(answer)) return { ...result, kind: 'held', anchor: event, reason: answer.outboxed ? 'outboxed' : 'unproven-delivery', deferred: args.deferred }
		if ((answer.accepted > 0 || answer.alreadyDelivered) && event.type === 'contact.profile.updated') await args.afterProfile?.(event)
		result.accepted += answer.accepted
		result.rejected += answer.rejected
		if (answer.retainedRejected) result.retainedRejected = (result.retainedRejected ?? 0) + answer.retainedRejected
		result.deferred.push(...(answer.deferred ?? []))
	}
	return result
}

function retryAnswerNeedsHold(answer: DrovrBatchOutcome): boolean {
	const outboxed = answer.outboxed !== undefined && answer.outboxed !== 0
	const proven = answer.accepted > 0 || answer.rejected > 0 || (answer.deferred?.length ?? 0) > 0 || answer.alreadyDelivered || (answer.supersededUnsubscribes ?? 0) > 0 || (answer.retainedRejected ?? 0) > 0
	return outboxed || (answer.retainedHeld ?? 0) > 0 || !proven
}

type RetryStep = {
	run<T>(id: string, callback: () => Promise<T>): Promise<unknown>
	sendEvent(id: string, payload: unknown): Promise<unknown>
}

export type ContactSyncRetryReceipt =
	| { status: 'held'; remaining: number; reason: 'outboxed' | 'unproven-delivery' }
	| { status: 'delivered'; accepted: number; rejected: number; priorRejected?: number }
	| { status: 'continued'; remaining: number; deferred: number; accepted: number; rejected: number; attempt: number }
	| {
			status: 'rescheduled'
			deferred: number
			attempt: number
			reason?: string
	  }

export async function runContactSyncStragglerRetry(args: {
	event: { data: DrovrContactSyncRetryRequested['data'] }
	step: RetryStep
	env: Readonly<Record<string, string | undefined>>
	now: () => number
	runId?: string
	pacedDeliver?: (id: string, events: DrovrShadowEvent[]) => Promise<DrovrBatchOutcome>
	pacedBirth?: (id: string, contacts: string[]) => Promise<void | DrovrBatchOutcome>
	afterProfile?: (event: DrovrShadowEvent) => Promise<void>
	/** Persist a bounded continuation on an unfinished anchor; never publish it. */
	holdBatch?: (args: {
		anchor: DrovrShadowEvent
		data: DrovrContactSyncRetryRequested['data']
		reason: 'outboxed' | 'unproven-delivery'
	}) => Promise<void>
	beforeDeliver?: () => Promise<void | 'held'>
	/** Production supplies fresh full-membership proof, never phase counters. */
	proveComplete?: () => Promise<import('./contact-sync-retry-acknowledgement').RetryAcknowledgementProof>
	/** Delivers in deferNotLive mode; throws on a transient failure. */
	deliver: (events: DrovrShadowEvent[]) => Promise<DrovrBatchOutcome>
	warn: (event: string, fields: Record<string, unknown>) => unknown
	/** Births these contacts' directory actors (directoryBirthEvents). */
	birth: (contactIds: string[]) => Promise<void>
	/** Records that drovr fully accepted a profile version (the version store). */
	acknowledge: (contactId: string, profileVersion: number) => Promise<void>
}): Promise<ContactSyncRetryReceipt> {
	const { items, attempt, acknowledge, paceClass, firstFailedAt, deliverySource, carry = [], rejectedCarry = 0 } = args.event.data
	const nowMs = (await args.step.run('now', async () => args.now())) as number
	// Hard physical-run quota, including every cold-start and retry booking.
	const quota = 1
	if (!Number.isSafeInteger(rejectedCarry) || rejectedCarry < 0) throw new Error('RetryContinuation: you resumed stragglers, and it failed because the rejection proof is invalid. Accepted: a nonnegative whole rejection count. Fix: restore the original continuation metadata. Debug: inspect the retry request.')
	const continuationId = args.runId ?? createHash('sha256').update(JSON.stringify([args.event.data, nowMs])).digest('hex')
	const renew = (nextItems: DeferredDrovrEvent[], nextAttempt: number, options: { carry?: DeferredDrovrEvent[]; rejected?: number; id?: string; ts?: number } = {}) => {
		const request = contactSyncRetryRequest(nextItems, nextAttempt, nowMs, acknowledge, paceClass, firstFailedAt, deliverySource)
		return routeContactSyncRetry({ ...request, ...(options.id ? { id: options.id } : {}), ...(options.ts === undefined ? {} : { ts: options.ts }), data: { ...request.data, ...(args.event.data.ownedKeys ? { ownedKeys: args.event.data.ownedKeys } : {}), ...(args.event.data.heldBatchRelease ? { heldBatchRelease: args.event.data.heldBatchRelease } : {}), ...(options.carry?.length ? { carry: options.carry } : {}), ...((options.rejected ?? rejectedCarry) ? { rejectedCarry: options.rejected ?? rejectedCarry } : {}) } })
	}
	// Even a healthy pause publishes only first-owned immutable work.
	if (await args.beforeDeliver?.() === 'held') return { status: 'held', remaining: items.length + carry.length, reason: 'unproven-delivery' }
	const config = parseDrovrProfileSyncConfig(args.env)
	if (!config.enabled && !isUncappedOfferRetry(args.event.data) && deliverySource !== 'kit-directory-ingest' && deliverySource !== 'evergreen-pitch-backfill') {
		// A pause is healthy, not another HTTP refusal. Fresh durable IDs
		// prevent Inngest's 24h dedupe from swallowing unchanged work.
		await args.step.sendEvent('reschedule', renew(items, attempt, { carry, id: `contact-sync-paused:${continuationId}`, ts: nowMs + 2 * 60 * 60_000 }))
		return { status: 'rescheduled', deferred: items.length + carry.length, attempt, reason: config.reason }
	}
	const hold = async (anchor: DrovrShadowEvent, reason: 'outboxed' | 'unproven-delivery'): Promise<Extract<ContactSyncRetryReceipt, { status: 'held' }>> => {
		if (!args.holdBatch) throw new HeldBatchContinuationError({ reason: 'the durable held-batch adapter is not configured' })
		await args.holdBatch({ anchor, data: args.event.data, reason })
		return { status: 'held', remaining: items.length + carry.length, reason }
	}
	const outcome: DrovrBatchOutcome = { accepted: 0, rejected: 0, deferred: [] }
	// A legacy queued retry may contain many events. Each paced send gets its
	// own memoized step, so a slot refusal resumes after completed sends.
	for (const { event } of items.slice(0, quota)) {
		const id = `paced-deliver:${retryStepKey(event)}`
		const answer = args.pacedDeliver ? await args.pacedDeliver(id, [event]) : (await args.step.run(id, () => args.deliver([event]))) as DrovrBatchOutcome
		// Durable capture is owed work, not a delivery receipt. A zero/zero
		// answer without retained acceptance or local closure cannot finish
		// this member either. Park the whole remaining logical batch before
		// returning; held work must not auto-publish another continuation.
		if (retryAnswerNeedsHold(answer)) return hold(event, answer.outboxed ? 'outboxed' : 'unproven-delivery')
		if ((answer.accepted > 0 || answer.alreadyDelivered) && event.type === 'contact.profile.updated') await args.afterProfile?.(event)
		outcome.accepted += answer.accepted
		outcome.rejected += answer.rejected
		if (answer.retainedRejected) outcome.retainedRejected = (outcome.retainedRejected ?? 0) + answer.retainedRejected
		outcome.deferred!.push(...(answer.deferred ?? []))
	}
	const resolved = await birthThenRedeliver({
		deferred: outcome.deferred ?? [],
		step: args.step,
		birth: args.birth,
		deliver: args.deliver,
		pacedDeliver: args.pacedDeliver,
		pacedBirth: args.pacedBirth,
		afterProfile: args.afterProfile,
	})
	if (resolved.kind === 'held') return hold(resolved.anchor, resolved.reason)
	const refused = [...carry, ...resolved.deferred]
	const rejected = outcome.rejected + resolved.rejected
	let priorRejected = rejectedCarry + (outcome.retainedRejected ?? 0) + (resolved.retainedRejected ?? 0)
	let totalRejected = priorRejected + rejected
	if (items.length > quota) {
		await args.step.sendEvent('continue-bounded-retry', renew(items.slice(quota), attempt, { carry: refused, rejected: totalRejected, id: `contact-sync-slice:${continuationId}`, ts: nowMs }))
		return { status: 'continued', remaining: items.length - quota, deferred: refused.length, accepted: outcome.accepted + resolved.accepted, rejected, attempt }
	}
	if (refused.length === 0) {
		if (args.proveComplete) {
			const proof = await args.proveComplete()
			if (!proof.proved || totalRejected > proof.rejected) {
				const anchor = items[0]?.event ?? carry[0]?.event
				if (!anchor) throw new HeldBatchContinuationError({ reason: 'the empty logical request has no complete scoped receiver proof' })
				return hold(anchor, 'unproven-delivery')
			}
			priorRejected += proof.rejected - totalRejected
			totalRejected = proof.rejected
		}
		// drovr now holds every event of the version (Macroscope on #319):
		// acknowledge it, so live writers stop re-pushing it unchanged.
		if (acknowledge && totalRejected === 0)
			await args.step.run('acknowledge-version', () =>
				args.acknowledge(acknowledge.contactId, acknowledge.profileVersion),
			)
		return {
			status: 'delivered',
			accepted: outcome.accepted + resolved.accepted,
			rejected,
			...(priorRejected ? { priorRejected } : {}),
		}
	}
	if (attempt >= STRAGGLER_STUCK_AFTER_ATTEMPTS)
		await args.warn('drovr.contact_sync.straggler_stuck', {
			attempt,
			reasons: [...new Set(refused.map((item) => item.reason))],
			idempotencyKeys: refused.map((item) => item.event.idempotencyKey),
		})
	await args.step.sendEvent(
		'reschedule',
		renew(refused, attempt + 1, { rejected: totalRejected }),
	)
	return {
		status: 'rescheduled',
		deferred: refused.length,
		attempt: attempt + 1,
	}
}
