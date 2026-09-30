import { log } from '@/server/logger'

import type { DrovrShadowEvent } from './drovr-shadow-emitter'

/**
 * How far before the send a birth's `occurredAt` may sit (row 201g, the
 * hawk 2026-09-30). drovr arms a journey's drips from the birth's
 * `occurredAt`, so a birth sent late with its original time fires every
 * drip it missed at once: a paced backfill whose events share one instant,
 * or an outage backlog, becomes a one-instant wave. Clamped, each birth
 * starts no earlier than 5 minutes before it reaches drovr.
 */
export const DROVR_BIRTH_CLAMP_SKEW_MS = 5 * 60_000

// Literals, not the emitter's constants: the emitter imports this module.
const CONTACT_DIRECTORY_JOURNEY_ID = 'contact-directory'
const EVERGREEN_OFFER_JOURNEY_ID = 'crash-course-evergreen-offer'

/**
 * A birth on a sending journey: a `contact.created` anywhere but the
 * contact directory (value-path, the shadow newsletter, an owner copy), or
 * the evergreen offer's `course.sequence-exhausted`, which starts that
 * journey. Directory births keep the contact's `createdAt` (the directory
 * sends nothing), and stops and facts keep their own time: it is the fact.
 */
export function isSendingJourneyBirth(event: DrovrShadowEvent): boolean {
	if (event.type === 'contact.created')
		return event.journeyId !== CONTACT_DIRECTORY_JOURNEY_ID
	return (
		event.type === 'course.sequence-exhausted' &&
		event.journeyId === EVERGREEN_OFFER_JOURNEY_ID
	)
}

export type ClampedBirths = {
	events: DrovrShadowEvent[]
	/** Each clamped birth's original lag behind the send, in whole seconds. */
	lagSeconds: number[]
}

/**
 * The events as they go to drovr: a sending-journey birth whose
 * `occurredAt` is older than `now - skew` is moved up to `now - skew`.
 * Nothing else changes, the idempotency key included. drovr's event log is
 * first-write-wins by key (adapter-d1 `event-log.ts` `EventLog.append`:
 * a duplicate returns the stored event, with no body compare), so a retry
 * clamped to a later instant dedupes against the first post, never
 * conflicts with it. An `occurredAt` that does not parse is left alone:
 * drovr refuses it as malformed, which is its call.
 */
export function clampBirths(
	events: readonly DrovrShadowEvent[],
	nowMs: number,
): ClampedBirths {
	const floorMs = nowMs - DROVR_BIRTH_CLAMP_SKEW_MS
	const lagSeconds: number[] = []
	const clamped = events.map((event) => {
		if (!isSendingJourneyBirth(event)) return event
		const at = Date.parse(event.occurredAt)
		if (Number.isNaN(at) || at >= floorMs) return event
		lagSeconds.push(Math.floor((nowMs - at) / 1000))
		return { ...event, occurredAt: new Date(floorMs).toISOString() }
	})
	return { events: clamped, lagSeconds }
}

/**
 * One line per send that clamped anything, so an outage backlog or a
 * backfill's queue wait shows up in Axiom: `count` sums the clamps, and
 * `lagSeconds` carries each birth's original lag.
 */
export async function logClampedBirths(
	clamped: ClampedBirths,
	path: 'single' | 'batch',
	info: typeof log.info = log.info,
): Promise<void> {
	if (clamped.lagSeconds.length === 0) return
	try {
		await info('drovr.birth.clamped', {
			path,
			count: clamped.lagSeconds.length,
			maxLagSeconds: Math.max(...clamped.lagSeconds),
			lagSeconds: clamped.lagSeconds,
		})
	} catch {
		// Logging cannot change what is sent.
	}
}
