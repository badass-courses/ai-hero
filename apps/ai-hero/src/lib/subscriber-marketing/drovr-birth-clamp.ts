import { log } from '@/server/logger'

import type { DrovrShadowEvent } from './drovr-shadow-emitter'

/**
 * How far before the send a birth's `occurredAt` may sit (row 201g, the
 * hawk 2026-09-30). drovr arms a journey's drips from the birth's
 * `occurredAt`, so a birth sent late with its original time fires every
 * drip it missed at once: a paced backfill whose events share one instant,
 * or an outage backlog, becomes a one-instant wave. Clamped, each birth
 * starts no earlier than 5 minutes before its FIRST send. A retry or a
 * replay posts those same bytes (see `clampBirths`), so a birth replayed
 * hours later is hours old.
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
	/** Each clamped birth's journey, in the same order as `lagSeconds`. */
	journeyIds: string[]
}

/**
 * The events as they go to drovr: a sending-journey birth whose
 * `occurredAt` is older than `clampAt - skew` is moved up to
 * `clampAt - skew`. Nothing else changes, the idempotency key included. An
 * `occurredAt` that does not parse is left alone: drovr refuses it as
 * malformed, which is its call.
 *
 * `clampAt` is the event's FIRST send, fixed once and reused by every
 * retry and replay, so each attempt posts identical bytes (the hawk,
 * #345 S1). drovr's log keeps the first write of a key, but its
 * `deliverEvent` forwards the REQUEST's event to the actor even when the
 * append was a duplicate (apps/api `events.ts`), so a retry re-clamped to
 * a later instant after an ambiguous first post would fold an `occurredAt`
 * the log does not hold. Where each path fixes it:
 * - the Inngest lanes: one memoized step per run (`drovrClampInstant`).
 *   It is the run's instant, so a birth whose step waits on an earlier
 *   event's retries goes out up to that retry span old: bounded by one
 *   run, and cheaper than a step per birth;
 * - the dispatch fallback's direct post: one instant before it posts;
 * - the owner-birth guard: its run's start. The one exception: a re-post
 *   of a birth drovr logged but never folded carries the guard's instant,
 *   not the first send's, until drovr row 209 folds the stored event;
 * - the outbox: an entry captured after a failed send carries that send's
 *   instant as its row's `firstFailedAt`, and the replay clamps at
 *   `firstFailedAt`, so a row posts the same bytes on every replay.
 */
export function clampBirths(
	events: readonly DrovrShadowEvent[],
	clampAt: number,
): ClampedBirths {
	const floorMs = clampAt - DROVR_BIRTH_CLAMP_SKEW_MS
	const lagSeconds: number[] = []
	const journeyIds: string[] = []
	const clamped = events.map((event) => {
		if (!isSendingJourneyBirth(event)) return event
		const at = Date.parse(event.occurredAt)
		if (Number.isNaN(at) || at >= floorMs) return event
		lagSeconds.push(Math.floor((clampAt - at) / 1000))
		journeyIds.push(event.journeyId)
		return { ...event, occurredAt: new Date(floorMs).toISOString() }
	})
	return { events: clamped, lagSeconds, journeyIds }
}

/** The clamp line lists at most this many births' lags and journeys. */
export const DROVR_CLAMP_LOG_SAMPLE = 10

/**
 * One line per send that clamped anything, so an outage backlog or a
 * backfill's queue wait shows up in Axiom: `count` sums the clamps,
 * `maxLagSeconds` is the largest of them all, and `journeyCounts` counts
 * them by journey. `lagSeconds` and `journeyIds` carry the first
 * `DROVR_CLAMP_LOG_SAMPLE` births' original lags and journeys, in the same
 * order, so a 100-event batch doesn't log 100 of each. It is logged on
 * every attempt, so a retried send repeats its line: count sends, not
 * births.
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
			journeyCounts: countBy(clamped.journeyIds),
			lagSeconds: clamped.lagSeconds.slice(0, DROVR_CLAMP_LOG_SAMPLE),
			journeyIds: clamped.journeyIds.slice(0, DROVR_CLAMP_LOG_SAMPLE),
		})
	} catch {
		// Logging cannot change what is sent.
	}
}

function countBy(values: readonly string[]): Record<string, number> {
	const counts: Record<string, number> = {}
	for (const value of values) counts[value] = (counts[value] ?? 0) + 1
	return counts
}
