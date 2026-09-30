import { log } from '@/server/logger'

import { clampBirths, logClampedBirths } from './drovr-birth-clamp'
import { parseRetryAfterMs } from './drovr-retry-after'

import {
	boundedProblemBody,
	deliverDrovrShadowEvent,
	type DrovrDeliveryConfig,
	type DrovrDeliveryOutcome,
	type DrovrShadowEvent,
} from './drovr-shadow-emitter'
import {
	drovrStopVerdict,
	isColdStartUnhandledProblem,
	isEventNotLiveProblem,
	isHeldStopRefusal,
	isNeverBornOwnerStopProblem,
	isStopEvent,
	refusalsByAnswer,
	type DrovrStopVerdict,
} from './drovr-stop-verdict'

export { isHeldStopRefusal, isNeverBornOwnerStopProblem, refusalsByAnswer }

export class DrovrDeliveryFailedError extends Error {
	constructor(
		readonly idempotencyKey: string,
		readonly reason: string,
		readonly httpStatus?: number,
		/** drovr's Retry-After, in milliseconds. */
		readonly retryAfterMs?: number,
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
			outcome.httpStatus,
			outcome.retryAfterMs,
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
		readonly httpStatus?: number,
		/** drovr's Retry-After, in milliseconds. */
		readonly retryAfterMs?: number,
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
	/**
	 * The items drovr refused for good (a 4xx that is not event-not-live or
	 * a deferral), counted in `rejected`: the caller holds the stops among
	 * them (row 204c).
	 */
	refused?: RefusedDrovrEvent[]
}

export type RefusedDrovrEvent = {
	event: DrovrShadowEvent
	/** The whole batch's status, or the item's problem status (else 400). */
	httpStatus: number
	problem: unknown
}

export type DeferredDrovrEventReason = 'event-not-live' | 'cold-start-unhandled'

export type DeferredDrovrEvent = {
	event: DrovrShadowEvent
	reason: DeferredDrovrEventReason
}

/**
 * A single post's answer was a never-born owner copy of a stop: released,
 * nothing owed (drovrStopVerdict).
 */
export function isNeverBornOwnerStop(
	event: DrovrShadowEvent,
	outcome: DrovrDeliveryOutcome,
): boolean {
	return (
		outcome.status === 'rejected' &&
		isStopEvent(event) &&
		drovrStopVerdict(event, outcome) === 'released'
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
	return isColdStartUnhandledProblem(problem)
		? 'cold-start-unhandled'
		: undefined
}

/** A stop's verdict for a batch answer; undefined for a fact or a birth. */
const stopVerdictOf = (
	event: DrovrShadowEvent | undefined,
	answer: { httpStatus?: number; problem?: unknown },
): DrovrStopVerdict | undefined =>
	event && isStopEvent(event) ? drovrStopVerdict(event, answer) : undefined

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
	now?: () => number
	info?: typeof log.info
}): Promise<DrovrBatchOutcome> {
	const fetcher = args.fetcher ?? fetch
	const warn = args.warn ?? log.warn
	// Row 201g: a sending-journey birth never reaches drovr dated more than
	// 5 minutes before its send. Items are read back by index, so the
	// clamped copies stand in only for the body.
	const clamped = clampBirths(args.events, (args.now ?? Date.now)())
	await logClampedBirths(clamped, 'batch', args.info)
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
				body: JSON.stringify({ events: clamped.events }),
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
			// Row 204c: every stop in the chunk gets the one stop rule. A
			// directory stop's cold-start landed (the suppression row is
			// written), whatever else the chunk carries.
			const verdicts = args.events.map((event) =>
				stopVerdictOf(event, { httpStatus: response.status, problem }),
			)
			const stopsLanded = verdicts.filter((v) => v === 'landed').length
			const rest = args.events.filter((_, i) => verdicts[i] !== 'landed')
			if (rest.length === 0) return { accepted: stopsLanded, rejected: 0 }
			const deferral =
				response.status === 409 && args.deferNotLive
					? deferralReasonOf(problem)
					: undefined
			if (deferral) {
				// A stop the rule holds (a cold-start off the directory) is
				// refused, never deferred to a retry.
				const isHeld = (event: DrovrShadowEvent) =>
					verdicts[args.events.indexOf(event)] === 'held'
				const later = rest.filter((event) => !isHeld(event))
				const held = rest.filter(isHeld)
				if (deferral === 'cold-start-unhandled')
					for (const event of later) await warnColdStart(warn, event)
				return {
					accepted: stopsLanded,
					rejected: held.length,
					...(later.length > 0
						? {
								deferred: later.map((event) => ({ event, reason: deferral })),
							}
						: {}),
					...(held.length > 0
						? {
								refused: held.map((event) => ({
									event,
									httpStatus: response.status,
									problem,
								})),
							}
						: {}),
				}
			}
			if (response.status === 409 && isEventNotLiveProblem(problem)) {
				throw new DrovrBatchDeliveryFailedError(
					keys,
					'drovr does not take this event type yet (409 event-not-live)',
				)
			}
			// A stop still owed (408, 429): drovr recorded nothing for the
			// chunk, so the whole chunk retries.
			if (verdicts.includes('pending')) {
				throw new DrovrBatchDeliveryFailedError(
					keys,
					`drovr has not taken the chunk's stops yet (${response.status})`,
					response.status,
					parseRetryAfterMs(response.headers?.get?.('retry-after'), Date.now()),
				)
			}
			await warnSafely(warn, 'drovr.shadow.batch_rejected', {
				status: response.status,
				count: rest.length,
				tenantId: args.events[0]?.tenantId,
				problem,
			})
			return {
				accepted: stopsLanded,
				rejected: rest.length,
				refused: rest.map((event) => ({
					event,
					httpStatus: response.status,
					problem,
				})),
			}
		}
		if (response.status !== 200) {
			throw new DrovrBatchDeliveryFailedError(
				keys,
				`drovr answered ${response.status}`,
				response.status,
				parseRetryAfterMs(response.headers?.get?.('retry-after'), Date.now()),
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
		const refused: RefusedDrovrEvent[] = []
		let notLive = 0
		let deferredRejected = 0
		let stopsLanded = 0
		let stopsLandedRejected = 0
		for (const item of body.results) {
			const event = args.events[item.index]
			if (item.status === 'accepted') continue
			// Row 204c: a stop's item answer goes through the one stop rule.
			const verdict = stopVerdictOf(
				event,
				item.status === 'failed'
					? {}
					: {
							httpStatus: problemStatusOf(item.detail) ?? 400,
							problem: item.detail,
						},
			)
			if (verdict === 'landed') {
				// The suppression row is written; nothing to retry or defer.
				stopsLanded += 1
				if (item.status === 'rejected') stopsLandedRejected += 1
				continue
			}
			const deferral = args.deferNotLive
				? deferralReasonOf(item.detail)
				: undefined
			if (deferral && event && verdict !== 'held') {
				deferred.push({ event, reason: deferral })
				if (item.status === 'rejected') deferredRejected += 1
				if (deferral === 'cold-start-unhandled')
					await warnColdStart(warn, event)
			} else if (
				item.status === 'failed' ||
				verdict === 'pending' ||
				isEventNotLiveProblem(item.detail)
			) {
				if (item.status === 'rejected' && isEventNotLiveProblem(item.detail))
					notLive += 1
				if (event) failedKeys.push(event.idempotencyKey)
			} else if (item.status === 'rejected') {
				if (event)
					refused.push({
						event,
						httpStatus: problemStatusOf(item.detail) ?? 400,
						problem: item.detail,
					})
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
		return {
			accepted,
			rejected,
			...(deferred.length > 0 ? { deferred } : {}),
			...(refused.length > 0 ? { refused } : {}),
		}
	} finally {
		clearTimeout(timeout)
	}
}

const problemStatusOf = (problem: unknown): number | undefined => {
	const status = (problem as { status?: unknown } | null)?.status
	return typeof status === 'number' && Number.isInteger(status)
		? status
		: undefined
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
