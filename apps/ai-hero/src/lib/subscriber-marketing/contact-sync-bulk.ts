import { DROVR_EVENTS_DELIVER_BULK_EVENT } from '@/inngest/events/drovr'
import { outboxEntryForEvent } from './drovr-outbox'
import type { DrovrOutboxCaptureFn } from './drovr-outbox-step'
import type { DrovrShadowEvent } from './drovr-shadow-emitter'

/** Persist before publishing. A crash on either side of send leaves the same
 * bytes/key in the outbox. Never claim syncedThrough on an optional capture.
 */
export async function queueContactSyncBulk(
	events: DrovrShadowEvent[],
	ports: {
		capture: DrovrOutboxCaptureFn
		send: (
			events: {
				id: string
				name: typeof DROVR_EVENTS_DELIVER_BULK_EVENT
				data: { source: 'contact-profile-sync'; events: DrovrShadowEvent[] }
			}[],
		) => Promise<unknown>
	},
) {
	const captured = await ports.capture(
		events.map((event) => outboxEntryForEvent(event, 'bulk')),
		'contact sync queued for paced delivery',
	)
	if (captured.status !== 'outboxed')
		throw new Error(
			'SyncOutbox: you queued a profile delta, and it failed because the durable outbox is unavailable. Accepted: a persisted outbox row for every event. Fix: restore outbox storage before retrying. Debug: inspect the outbox capture receipt.',
		)
	if (events.length > 0)
		await ports.send([
			{
				id: `sync-bulk:${events[0]!.idempotencyKey}`,
				name: DROVR_EVENTS_DELIVER_BULK_EVENT,
				data: { source: 'contact-profile-sync', events },
			},
		])
	return { accepted: 0, rejected: 0 }
}
