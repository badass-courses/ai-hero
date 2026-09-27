import { log } from '@/server/logger'

import {
	boundedProblemBody,
	deliverDrovrShadowEvent,
	isEventNotLiveProblem,
	type DrovrDeliveryConfig,
	type DrovrDeliveryOutcome,
	type DrovrShadowEvent,
} from './drovr-shadow-emitter'

export class DrovrDeliveryFailedError extends Error {
	constructor(
		readonly idempotencyKey: string,
		readonly reason: string,
	) {
		super(`drovr delivery failed for ${idempotencyKey}: ${reason}`)
		this.name = 'DrovrDeliveryFailedError'
	}
}

/**
 * One event through one attempt, as the step body. `failed` throws so
 * Inngest retries the step with backoff; `rejected` is final and is
 * logged, never retried; `accepted` returns. Pure over its inputs so it
 * can be tested without the function runtime.
 */
export async function deliverOrThrow(args: {
	event: DrovrShadowEvent
	config: DrovrDeliveryConfig
	fetcher?: typeof fetch
	warn?: typeof log.warn
}): Promise<DrovrDeliveryOutcome> {
	const outcome = await deliverDrovrShadowEvent({
		event: args.event,
		config: args.config,
		fetcher: args.fetcher,
	})
	if (outcome.status === 'failed') {
		throw new DrovrDeliveryFailedError(
			args.event.idempotencyKey,
			outcome.reason,
		)
	}
	if (outcome.status === 'rejected') {
		const warn = args.warn ?? log.warn
		try {
			await warn('drovr.shadow.rejected', {
				status: outcome.httpStatus,
				journeyId: args.event.journeyId,
				type: args.event.type,
				idempotencyKey: args.event.idempotencyKey,
				problem: outcome.problem,
			})
		} catch {
			// Logging cannot change the delivery result.
		}
	}
	return outcome
}

/** Drovr's cap on one `POST /events/batch`. */
export const DROVR_BATCH_MAX = 100

/** `…/events` becomes `…/events/batch`. */
export function batchIngestUrl(ingestUrl: string): string {
	return `${ingestUrl.replace(/\/+$/, '')}/batch`
}

export class DrovrBatchDeliveryFailedError extends Error {
	constructor(
		readonly failedKeys: readonly string[],
		readonly reason: string,
	) {
		super(
			`drovr batch delivery failed for ${failedKeys.length} event(s): ${reason}`,
		)
		this.name = 'DrovrBatchDeliveryFailedError'
	}
}

export type DrovrBatchOutcome = {
	accepted: number
	rejected: number
	/** deferNotLive only: refusals to re-send unchanged after drovr's straggler pass. */
	deferred?: DeferredDrovrEvent[]
}

export type DeferredDrovrEventReason = 'event-not-live' | 'cold-start-unhandled'

export type DeferredDrovrEvent = {
	event: DrovrShadowEvent
	reason: DeferredDrovrEventReason
}

const DIRECTORY_STOP_TYPES: ReadonlySet<string> = new Set([
	'contact.unsubscribed',
	'contact.bounced',
	'contact.complained',
])

/**
 * A stop for org-aihero's contact directory. drovr writes its suppression
 * row before folding, so a cold-start-unhandled answer (no directory actor)
 * still means the stop landed (mig-10, 2026-09-27).
 */
function isDirectoryStop(event: DrovrShadowEvent | undefined): boolean {
	return (
		event !== undefined &&
		event.tenantId === 'org-aihero' &&
		event.journeyId === 'contact-directory' &&
		DIRECTORY_STOP_TYPES.has(event.type)
	)
}

const CONTACT_NEVER_BORN_PROBLEM = 'urn:drovr:problem:contact-never-born'

/**
 * A stop's owner copy (the fan-out to a journey the contact is owned for)
 * that drovr refused because the contact has no actor there, and the stop
 * does not start one. The directory stop is the suppression authority and
 * stays a real rejection; this copy can never land, so re-sending it only
 * repeats the refusal (swg6e, 2026-09-27).
 */
export function isNeverBornOwnerStop(
	event: DrovrShadowEvent,
	outcome: DrovrDeliveryOutcome,
): boolean {
	if (outcome.status !== 'rejected' || outcome.httpStatus !== 409) return false
	const problem = outcome.problem
	return (
		event.tenantId === 'org-aihero' &&
		event.idempotencyKey.startsWith('owner:') &&
		event.journeyId !== 'contact-directory' &&
		DIRECTORY_STOP_TYPES.has(event.type) &&
		typeof problem === 'object' &&
		problem !== null &&
		(problem as { type?: unknown }).type === CONTACT_NEVER_BORN_PROBLEM
	)
}

/**
 * The contact-sync push contract (§4): event-not-live means the contact's
 * directory actor is still v1; cold-start-unhandled that it has none. Either
 * way nothing was recorded and the key is not consumed.
 */
function deferralReasonOf(
	problem: unknown,
): DeferredDrovrEventReason | undefined {
	if (isEventNotLiveProblem(problem)) return 'event-not-live'
	const text =
		typeof problem === 'string'
			? problem
			: problem && typeof problem === 'object'
				? [
						(problem as { type?: unknown }).type,
						(problem as { code?: unknown }).code,
					]
						.filter((value): value is string => typeof value === 'string')
						.join(' ')
				: ''
	return text.includes('cold-start-unhandled')
		? 'cold-start-unhandled'
		: undefined
}

type BatchItemResult = {
	index: number
	status: 'accepted' | 'rejected' | 'failed'
	detail?: string
}

type BatchBody = {
	accepted: number
	rejected: number
	failed: number
	results: BatchItemResult[]
}

const BATCH_ITEM_STATUSES = new Set(['accepted', 'rejected', 'failed'])

function isBatchBody(value: unknown): value is BatchBody {
	if (typeof value !== 'object' || value === null) return false
	const body = value as Record<string, unknown>
	return (
		typeof body.accepted === 'number' &&
		typeof body.rejected === 'number' &&
		typeof body.failed === 'number' &&
		Array.isArray(body.results)
	)
}

/**
 * Drovr answers one result per submitted item. A body that does not
 * cover every item exactly once with a known status is not a verdict on
 * the chunk; the caller retries rather than let an unrepresented event
 * count as delivered.
 */
function coversEveryEvent(body: BatchBody, count: number): boolean {
	if (body.results.length !== count) return false
	const seen = new Set<number>()
	for (const item of body.results) {
		if (
			typeof item !== 'object' ||
			item === null ||
			!Number.isInteger(item.index) ||
			item.index < 0 ||
			item.index >= count ||
			seen.has(item.index) ||
			!BATCH_ITEM_STATUSES.has(item.status)
		) {
			return false
		}
		seen.add(item.index)
	}
	return true
}

/**
 * Up to a hundred events of one tenant through one request, as the step
 * body. Drovr answers per item. `failed` items throw so Inngest retries
 * the whole chunk: replaying the accepted ones is safe, drovr dedupes on
 * the idempotency key and answers `appended: false`. `rejected` items are
 * final and warned once each. A transient envelope answer (5xx, network,
 * timeout) throws too; a 4xx envelope (bad key, bad shape) is final for
 * the chunk, warned and counted as rejected, never retried.
 */
export async function deliverBatchOrThrow(args: {
	events: readonly DrovrShadowEvent[]
	config: DrovrDeliveryConfig
	fetcher?: typeof fetch
	warn?: typeof log.warn
	timeoutMs?: number
	/**
	 * Contact sync: hand back items refused as event-not-live or
	 * cold-start-unhandled (`deferred`) instead of throwing, for a retry of
	 * the same event after drovr's daily straggler pass.
	 */
	deferNotLive?: boolean
}): Promise<DrovrBatchOutcome> {
	const fetcher = args.fetcher ?? fetch
	const warn = args.warn ?? log.warn
	const keys = args.events.map((event) => event.idempotencyKey)
	const controller = new AbortController()
	const timeout = setTimeout(() => controller.abort(), args.timeoutMs ?? 30_000)
	try {
		let response: Response
		try {
			response = await fetcher(batchIngestUrl(args.config.ingestUrl), {
				method: 'POST',
				headers: {
					authorization: `Bearer ${args.config.apiKey}`,
					'content-type': 'application/json',
				},
				body: JSON.stringify({ events: args.events }),
				signal: controller.signal,
			})
		} catch (error) {
			throw new DrovrBatchDeliveryFailedError(
				keys,
				error instanceof Error ? error.message : String(error),
			)
		}
		// A missing route is a drovr that has not deployed the batch ingress
		// yet, not a verdict on the events: retry until it has.
		if (response.status === 404 || response.status === 405) {
			throw new DrovrBatchDeliveryFailedError(
				keys,
				`drovr has no batch ingress (${response.status})`,
			)
		}
		if (response.status >= 400 && response.status < 500) {
			const problem = await boundedProblemBody(response)
			if (
				response.status === 409 &&
				deferralReasonOf(problem) === 'cold-start-unhandled' &&
				args.events.every(isDirectoryStop)
			) {
				return { accepted: args.events.length, rejected: 0 }
			}
			const deferral =
				response.status === 409 && args.deferNotLive
					? deferralReasonOf(problem)
					: undefined
			if (deferral) {
				if (deferral === 'cold-start-unhandled')
					for (const event of args.events) await warnColdStart(warn, event)
				return {
					accepted: 0,
					rejected: 0,
					deferred: args.events.map((event) => ({ event, reason: deferral })),
				}
			}
			if (response.status === 409 && isEventNotLiveProblem(problem)) {
				throw new DrovrBatchDeliveryFailedError(
					keys,
					'drovr does not take this event type yet (409 event-not-live)',
				)
			}
			await warnSafely(warn, 'drovr.shadow.batch_rejected', {
				status: response.status,
				count: args.events.length,
				tenantId: args.events[0]?.tenantId,
				problem,
			})
			return { accepted: 0, rejected: args.events.length }
		}
		if (response.status !== 200) {
			throw new DrovrBatchDeliveryFailedError(
				keys,
				`drovr answered ${response.status}`,
			)
		}
		const body: unknown = await response.json()
		if (!isBatchBody(body)) {
			throw new DrovrBatchDeliveryFailedError(
				keys,
				'drovr answered 200 without a batch body',
			)
		}
		if (!coversEveryEvent(body, args.events.length)) {
			throw new DrovrBatchDeliveryFailedError(
				keys,
				`drovr answered ${body.results.length} result(s) for ${args.events.length} event(s)`,
			)
		}
		const failedKeys: string[] = []
		const deferred: DeferredDrovrEvent[] = []
		let notLive = 0
		let deferredRejected = 0
		let stopsLanded = 0
		let stopsLandedRejected = 0
		for (const item of body.results) {
			const event = args.events[item.index]
			if (
				item.status !== 'accepted' &&
				isDirectoryStop(event) &&
				deferralReasonOf(item.detail) === 'cold-start-unhandled'
			) {
				// The suppression row is written; nothing to retry or defer.
				stopsLanded += 1
				if (item.status === 'rejected') stopsLandedRejected += 1
				continue
			}
			const deferral =
				args.deferNotLive && item.status !== 'accepted'
					? deferralReasonOf(item.detail)
					: undefined
			if (deferral && event) {
				deferred.push({ event, reason: deferral })
				if (item.status === 'rejected') deferredRejected += 1
				if (deferral === 'cold-start-unhandled')
					await warnColdStart(warn, event)
			} else if (
				item.status === 'failed' ||
				(item.status === 'rejected' && isEventNotLiveProblem(item.detail))
			) {
				if (item.status === 'rejected') notLive += 1
				if (event) failedKeys.push(event.idempotencyKey)
			} else if (item.status === 'rejected') {
				await warnSafely(warn, 'drovr.shadow.rejected', {
					journeyId: event?.journeyId,
					type: event?.type,
					idempotencyKey: event?.idempotencyKey,
					problem: item.detail,
				})
			}
		}
		if (failedKeys.length > 0) {
			throw new DrovrBatchDeliveryFailedError(
				failedKeys,
				`${failedKeys.length} of ${args.events.length} not taken by drovr (${notLive} event-not-live)`,
			)
		}
		const rejected = body.rejected - deferredRejected - stopsLandedRejected
		const accepted = body.accepted + stopsLanded
		return deferred.length > 0
			? { accepted, rejected, deferred }
			: { accepted, rejected }
	} finally {
		clearTimeout(timeout)
	}
}

async function warnColdStart(
	warn: typeof log.warn,
	event: DrovrShadowEvent,
): Promise<void> {
	// The contract expects an actor for every sending-journey contact; until
	// mig-10 says how to birth one, it is retried daily like event-not-live.
	await warnSafely(warn, 'drovr.contact_sync.cold_start_unhandled', {
		contactId: event.contactId,
		type: event.type,
		idempotencyKey: event.idempotencyKey,
	})
}

async function warnSafely(
	warn: typeof log.warn,
	message: string,
	fields: Record<string, unknown>,
): Promise<void> {
	try {
		await warn(message, fields)
	} catch {
		// Logging cannot change the delivery result.
	}
}

/** One step per tenant chunk; the run's event list is fixed, so the index is stable across retries. */
export function batchStepId(tenantId: string, chunkIndex: number): string {
	return `deliver-batch:${tenantId}:${chunkIndex}`
}

/**
 * One step per event, not per idempotency key. Dual-journey facts
 * (purchase, unsubscribe, course exhaustion) reuse one key across two
 * journeys, and Inngest memoizes a completed step by id, so a key-only id
 * would silently skip the second journey's delivery.
 */
export function deliveryStepId(event: DrovrShadowEvent): string {
	return `deliver:${event.journeyId}:${event.idempotencyKey}`
}
