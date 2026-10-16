import {
	deliverEventNameFor,
	type DrovrDeliverEventName,
	type DrovrDeliverySource,
} from '@/inngest/events/drovr'

export const BULK_OUTBOX_QUEUE_WAIT_MS = 24 * 60 * 60_000
/** Class metadata must survive every capture road. Unknown capped native
 * work stays conservative, never under the profile-only backfill guard. */
export function bulkOutboxSource(source: DrovrDeliverySource): 'bulkDelta' | 'bulkRestate' | 'bulkIngest' | 'bulkBackfill' | 'bulkEvergreen' {
	if (source === 'contact-profile-sync') return 'bulkDelta'
	if (source === 'contact-profile-restate') return 'bulkRestate'
	if (source === 'kit-directory-ingest') return 'bulkIngest'
	if (source === 'contact-sync-backfill') return 'bulkBackfill'
	return 'bulkEvergreen'
}
import { outboxEntryForEvent } from './drovr-outbox'
import type { DrovrOutboxCaptureFn } from './drovr-outbox-step'
import type { DrovrShadowEvent } from './drovr-shadow-emitter'

export async function persistContactSyncBulk(
	events: DrovrShadowEvent[],
	capture: DrovrOutboxCaptureFn,
	source: 'bulkDelta' | 'bulkRestate' | 'bulkBackfill',
	now = Date.now(),
) {
	if (events.length === 0) return
	const captured = await capture(
		events.map((event) => outboxEntryForEvent(event, source)),
		'contact sync queued for paced delivery',
		{ nextAttemptAt: new Date(now + BULK_OUTBOX_QUEUE_WAIT_MS) },
	)
	if (captured.status !== 'outboxed')
		throw new Error(
			'SyncOutbox: you queued a profile delta, and it failed because the durable outbox is unavailable. Accepted: a persisted outbox row for every event. Fix: restore outbox storage before retrying. Debug: inspect the outbox capture receipt.',
		)
}

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
				name: DrovrDeliverEventName
				data: {
					source: 'contact-profile-sync' | 'contact-profile-restate'
					events: DrovrShadowEvent[]
				}
			}[],
		) => Promise<unknown>
	},
	options: { restate?: boolean; now?: () => number } = {},
) {
	const source = options.restate
		? 'contact-profile-restate'
		: 'contact-profile-sync'
	await persistContactSyncBulk(
		events,
		ports.capture,
		options.restate ? 'bulkRestate' : 'bulkDelta',
		(options.now ?? Date.now)(),
	)
	if (events.length > 0)
		await ports.send([
			{
				id: `sync-bulk:${events[0]!.idempotencyKey}`,
				name: deliverEventNameFor(source),
				data: { source, events },
			},
		])
	return { accepted: 0, rejected: 0 }
}
