import { outboxEntryForEvent } from './drovr-outbox'
import { captureDrovrOutboxLive } from './drovr-outbox-live'
import {
	sendOrOutbox,
	type DrovrOutboxCaptureFn,
	type DrovrSendAttempt,
} from './drovr-outbox-step'
import type { DrovrBatchOutcome } from './drovr-shadow-delivery'
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
