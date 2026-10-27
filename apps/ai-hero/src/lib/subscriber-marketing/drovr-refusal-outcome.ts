import { drovrProblemCodes, isStopEvent } from './drovr-stop-verdict'
import type { DrovrShadowEvent } from './drovr-shadow-emitter'

/**
 * What a refusal from drovr means for one contact-sync event: a pure
 * decision, so the whole table is testable without a delivery.
 *
 * - `retry-later`: event-not-live. The actor exists on v1; re-send
 *   unchanged after drovr's straggler pass.
 * - `birth-then-redeliver`: the contact has no directory actor. Birth it
 *   (`directory:seed:<id>`, idempotent on the contact), then re-send.
 * - `final`: a real refusal. Warned, never retried, never born.
 */
export type DrovrRefusalOutcome =
	| 'retry-later'
	| 'birth-then-redeliver'
	| 'final'

export type DrovrRefusalCode =
	| 'event-not-live'
	| 'cold-start-unhandled'
	| 'cold-start-never-born'

export type DrovrEventKind =
	| 'stop'
	| 'profile'
	| 'links'
	| 'offer'
	| 'created'
	| 'other'

export function drovrEventKind(event: DrovrShadowEvent): DrovrEventKind {
	if (isStopEvent(event)) return 'stop'
	switch (event.type) {
		case 'contact.profile.updated':
			return 'profile'
		case 'contact.links.issued':
			return 'links'
		case 'contact.offer.issued':
			return 'offer'
		case 'contact.created':
			return 'created'
		default:
			return 'other'
	}
}

/** The directory-bound pushes ai-hero makes from a contact's profile. */
export const isProfileSyncKind = (kind: DrovrEventKind): boolean =>
	kind === 'profile' || kind === 'links' || kind === 'offer'

export function drovrRefusalCodeOf(
	problem: unknown,
): DrovrRefusalCode | undefined {
	const codes = drovrProblemCodes(problem)
	if (codes.includes('event-not-live')) return 'event-not-live'
	if (codes.includes('cold-start-unhandled')) return 'cold-start-unhandled'
	if (codes.includes('cold-start-never-born')) return 'cold-start-never-born'
	return undefined
}

/**
 * The refusal-to-outcome table. A never-born answer births only for the
 * profile-sync pushes: a stop never births (owner stops are released by
 * drovrStopVerdict), and a birth that is itself refused is not retried.
 * An unsubscribed contact never reaches this table: their profile, link and
 * offer pushes are held before any post (splitUnsubscribedHolds, and the
 * sync's snapshot), so drovr cannot refuse what is not sent.
 */
export function drovrRefusalOutcome(args: {
	code: DrovrRefusalCode | undefined
	kind: DrovrEventKind
}): DrovrRefusalOutcome {
	const { code, kind } = args
	if (!code) return 'final'
	if (code === 'event-not-live') return 'retry-later'
	if (code === 'cold-start-unhandled') return 'birth-then-redeliver'
	return isProfileSyncKind(kind) ? 'birth-then-redeliver' : 'final'
}

/**
 * The deferral reason a delivery hands back for an event, or undefined for a
 * final refusal. A never-born profile push takes the cold-start-unhandled
 * reason on purpose: that is the one the birth-then-redeliver path reads.
 */
export function drovrDeferralReasonOf(
	event: DrovrShadowEvent,
	problem: unknown,
): 'event-not-live' | 'cold-start-unhandled' | undefined {
	const outcome = drovrRefusalOutcome({
		code: drovrRefusalCodeOf(problem),
		kind: drovrEventKind(event),
	})
	if (outcome === 'retry-later') return 'event-not-live'
	if (outcome === 'birth-then-redeliver') return 'cold-start-unhandled'
	return undefined
}

/**
 * Profile, link and offer pushes for contacts who are unsubscribed. Stops,
 * suppressions and births are never held.
 */
export async function splitUnsubscribedHolds(
	events: readonly DrovrShadowEvent[],
	isUnsubscribed: (contactId: string) => Promise<boolean>,
): Promise<{ send: DrovrShadowEvent[]; held: DrovrShadowEvent[] }> {
	const standing = new Map<string, boolean>()
	const send: DrovrShadowEvent[] = []
	const held: DrovrShadowEvent[] = []
	for (const event of events) {
		if (!isProfileSyncKind(drovrEventKind(event))) {
			send.push(event)
			continue
		}
		if (!standing.has(event.contactId))
			standing.set(event.contactId, await isUnsubscribed(event.contactId))
		;(standing.get(event.contactId) ? held : send).push(event)
	}
	return { send, held }
}
