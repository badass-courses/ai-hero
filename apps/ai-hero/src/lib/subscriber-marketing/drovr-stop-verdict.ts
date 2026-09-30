import { isOutboxStop } from './drovr-outbox'
import type { RefusedDrovrEvent } from './drovr-shadow-delivery'
import type { DrovrShadowEvent } from './drovr-shadow-emitter'

/**
 * drovr (#346): an actor whose release does not take an event type yet
 * answers 409 `event-not-live`, saves nothing and leaves the key unused. The
 * only right answer is a retry later: every other 4xx stays final, but
 * dropping this one would lose the event for good.
 */
export function isEventNotLiveProblem(problem: unknown): boolean {
	return problemText(problem).includes('event-not-live')
}

/**
 * The contact-sync push contract (§4): cold-start-unhandled means the
 * contact has no actor there yet. Nothing was recorded and the key is not
 * consumed.
 */
export function isColdStartUnhandledProblem(problem: unknown): boolean {
	return problemText(problem).includes('cold-start-unhandled')
}

/** A problem's type and code, or the problem itself when it is a string. */
function problemText(problem: unknown): string {
	if (typeof problem === 'string') return problem
	if (!problem || typeof problem !== 'object') return ''
	const { type, code } = problem as { type?: unknown; code?: unknown }
	return [type, code]
		.filter((value): value is string => typeof value === 'string')
		.join(' ')
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
export function isDirectoryStop(event: DrovrShadowEvent | undefined): boolean {
	return (
		event !== undefined &&
		event.tenantId === 'org-aihero' &&
		event.journeyId === 'contact-directory' &&
		DIRECTORY_STOP_TYPES.has(event.type)
	)
}

const CONTACT_NEVER_BORN_PROBLEM = 'urn:drovr:problem:contact-never-born'

/**
 * drovr's never-born answer in either form it sends: the single route's
 * problem (`urn:drovr:problem:contact-never-born`), or a batch item's
 * `detail`, which is the actor's own body as a string,
 * `{"code":"cold-start-never-born","error":"…"}` (drovr events.ts
 * deliverBatchItem; ACTOR_REFUSAL_CODES.neverBorn). An item carries no
 * status, so neither form needs one.
 */
function isNeverBornProblem(problem: unknown): boolean {
	if (
		typeof problem === 'object' &&
		problem !== null &&
		(problem as { type?: unknown }).type === CONTACT_NEVER_BORN_PROBLEM
	)
		return true
	return problemText(problem).includes('cold-start-never-born')
}

/**
 * A stop's owner copy (the fan-out to a journey the contact is owned for)
 * that drovr refused because the contact has no actor there, and the stop
 * does not start one. Every stop kind counts, a purchase included: the
 * contact was never on that journey, so nothing there is owed and re-sending
 * only repeats the refusal (swg6e, 2026-09-27; row 204c). The directory stop
 * is the suppression authority and stays a real refusal.
 */
export function isNeverBornOwnerStopProblem(
	event: DrovrShadowEvent,
	problem: unknown,
): boolean {
	return (
		event.tenantId === 'org-aihero' &&
		event.idempotencyKey.startsWith('owner:') &&
		event.journeyId !== 'contact-directory' &&
		isOutboxStop({ eventType: event.type }) &&
		isNeverBornProblem(problem)
	)
}

/** A stop is an unsubscribe, bounce, complaint or purchase (the outbox's gates). */
export const isStopEvent = (event: DrovrShadowEvent) =>
	isOutboxStop({ eventType: event.type })

/**
 * What drovr's answer to a stop means (row 204c). Every path (the single
 * post, a whole batch, a batch item, the straggler retry and the replay)
 * decides through this one rule, so the same answer gets the same behaviour
 * everywhere. Facts and births keep their own rules.
 *
 * - `landed`: a 2xx, or a directory stop's cold-start-unhandled (drovr
 *   wrote the suppression row first).
 * - `released`: a never-born owner copy, of any stop kind. Nothing is owed.
 * - `pending`: not a verdict on the stop. A 5xx, no answer (a timeout or a
 *   network error), 408, 429 or 409 event-not-live, and nothing else. It
 *   stays owed and is retried, and it gates.
 * - `held`: every other 4xx, a cold-start-unhandled off the directory
 *   included (drovr says not to retry it; the hawk, 2026-09-30). Held for a
 *   human, and it gates.
 */
export type DrovrStopVerdict = 'landed' | 'released' | 'pending' | 'held'

export function drovrStopVerdict(
	event: DrovrShadowEvent,
	answer: { httpStatus?: number; problem?: unknown },
): DrovrStopVerdict {
	const { httpStatus, problem } = answer
	if (httpStatus === undefined || httpStatus >= 500) return 'pending'
	if (httpStatus >= 200 && httpStatus < 300) return 'landed'
	if (isColdStartUnhandledProblem(problem))
		return isDirectoryStop(event) ? 'landed' : 'held'
	if (isNeverBornOwnerStopProblem(event, problem)) return 'released'
	if (
		httpStatus === 408 ||
		httpStatus === 429 ||
		isEventNotLiveProblem(problem)
	)
		return 'pending'
	return 'held'
}

/**
 * Refusals grouped by drovr's answer (status and problem), so each held row
 * records its own cause, not the first one's.
 */
export function refusalsByAnswer(
	refused: readonly RefusedDrovrEvent[],
): RefusedDrovrEvent[][] {
	const groups = new Map<string, RefusedDrovrEvent[]>()
	for (const refusal of refused) {
		const key = `${refusal.httpStatus} ${JSON.stringify(refusal.problem ?? null)}`
		groups.set(key, [...(groups.get(key) ?? []), refusal])
	}
	return [...groups.values()]
}

/**
 * A refused stop that must be held for a human: drovr's answer was a final
 * 4xx and not a never-born owner copy (row 204c). Facts are never held.
 */
export function isHeldStopRefusal(refusal: RefusedDrovrEvent): boolean {
	return (
		isStopEvent(refusal.event) &&
		drovrStopVerdict(refusal.event, refusal) === 'held'
	)
}
