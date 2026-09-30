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
import {
	isNeverBornOwnerStopProblem,
	type DrovrBatchOutcome,
} from './drovr-shadow-delivery'
import type { DrovrShadowEvent } from './drovr-shadow-emitter'

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
	const toHold = refused.filter(
		({ event, problem }) =>
			isOutboxStop({ eventType: event.type }) &&
			!isNeverBornOwnerStopProblem(event, problem),
	)
	const refusedKeys = new Set(refused.map(({ event }) => event.idempotencyKey))
	if (toHold.length > 0) {
		const first = toHold[0]!
		await ports.hold(
			toHold.map(({ event }) => outboxEntryForEvent(event, 'contactSync')),
			`drovr refused the stop (${first.httpStatus}): ${JSON.stringify(first.problem ?? null)}`,
			first.httpStatus,
		)
	}
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
