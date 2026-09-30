import { isOutboxStop, outboxEntryForEvent } from './drovr-outbox'
import {
	captureDrovrOutboxLive,
	holdDrovrStopsLive,
	settleDrovrOutboxLive,
} from './drovr-outbox-live'
import {
	sendOrOutbox,
	type DrovrOutboxCaptureFn,
	type DrovrOutboxHoldFn,
	type DrovrOutboxSettleFn,
	type DrovrSendAttempt,
} from './drovr-outbox-step'
import type { DrovrBatchOutcome } from './drovr-shadow-delivery'
import type { DrovrShadowEvent } from './drovr-shadow-emitter'
import { isHeldStopRefusal, refusalsByAnswer } from './drovr-stop-verdict'

/**
 * Contact sync's batch sends (the straggler retry, the profile sync, and
 * their directory births) through sendOrOutbox. An outboxed batch reads as
 * nothing accepted, nothing refused: the replay delivers it under the same
 * keys, so nothing is rescheduled twice.
 */
export function contactSyncSendOrOutbox(
	attempt: DrovrSendAttempt,
	capture: DrovrOutboxCaptureFn = captureDrovrOutboxLive,
) {
	return (
		events: readonly DrovrShadowEvent[],
		send: () => Promise<DrovrBatchOutcome>,
	): Promise<DrovrBatchOutcome> =>
		sendOrOutbox<DrovrBatchOutcome>({
			attempt,
			send,
			unsent: () =>
				events.map((event) => outboxEntryForEvent(event, 'contactSync')),
			capture,
			outboxed: () => ({ accepted: 0, rejected: 0 }),
		})
}

export const DROVR_SETTLED_BY_STRAGGLER =
	'delivered by the contact-sync straggler retry'

export const DROVR_RELEASED_BY_STRAGGLER =
	'refused by drovr on the contact-sync straggler retry: never born there, nothing owed'

/**
 * Row 204c: after a straggler retry's send, the stops it carried that a
 * backfill outboxed while they waited (pending, source contactSync) are
 * settled if drovr took them, so their gate opens, and held if drovr
 * refused them for good (not "never born"). A stop deferred again stays
 * owed. An outboxed send (no answer) touches nothing: the replay owns it.
 * Settle and hold only move rows still pending, so a stop never outboxed
 * by a backfill is untouched. Returns the answer unchanged, less `refused`.
 */
export async function settleOrHoldStragglerStops(
	events: readonly DrovrShadowEvent[],
	answer: DrovrBatchOutcome,
	ports: {
		settle: DrovrOutboxSettleFn
		hold: DrovrOutboxHoldFn
	} = { settle: settleDrovrOutboxLive, hold: holdDrovrStopsLive },
): Promise<DrovrBatchOutcome> {
	const { refused = [], ...counts } = answer
	const stops = events.filter((event) =>
		isOutboxStop({ eventType: event.type }),
	)
	if (stops.length === 0) return counts
	const deferredKeys = new Set(
		(answer.deferred ?? []).map(({ event }) => event.idempotencyKey),
	)
	const toHold = refused.filter(isHeldStopRefusal)
	for (const group of refusalsByAnswer(toHold)) {
		const { httpStatus, problem } = group[0]!
		await ports.hold(
			group.map(({ event }) => outboxEntryForEvent(event, 'contactSync')),
			`drovr refused the stop (${httpStatus}): ${JSON.stringify(problem ?? null)}`,
			httpStatus,
		)
	}
	// A never-born owner copy is released: its row settles now, not after
	// the replay's day-long wait (row 204c).
	const refusedKeys = new Set(refused.map(({ event }) => event.idempotencyKey))
	const heldKeys = new Set(toHold.map(({ event }) => event.idempotencyKey))
	const released = refused.filter(
		({ event }) =>
			isOutboxStop({ eventType: event.type }) &&
			!heldKeys.has(event.idempotencyKey),
	)
	if (released.length > 0)
		await ports.settle(
			released.map(({ event }) => outboxEntryForEvent(event, 'contactSync')),
			DROVR_RELEASED_BY_STRAGGLER,
		)
	const landed = stops.filter(
		(event) =>
			!deferredKeys.has(event.idempotencyKey) &&
			!refusedKeys.has(event.idempotencyKey),
	)
	if (landed.length > 0)
		await ports.settle(
			landed.map((event) => outboxEntryForEvent(event, 'contactSync')),
			DROVR_SETTLED_BY_STRAGGLER,
		)
	return counts
}
