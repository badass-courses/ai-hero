import {
	deliverEventNameFor,
	type DrovrEventsDeliver,
	type DrovrDeliverEnvelope,
} from '@/inngest/events/drovr'
import { BULK_OUTBOX_QUEUE_WAIT_MS } from './contact-sync-bulk'
import type { DrovrOutboxPostOutcome, DrovrOutboxRow } from './drovr-outbox'
import type { DrovrShadowEvent } from './drovr-shadow-emitter'

function cappedSource(
	row: DrovrOutboxRow,
): DrovrEventsDeliver['data']['source'] | undefined {
	switch (row.source) {
		case 'bulkDelta':
			return 'contact-profile-sync'
		case 'bulkRestate':
			return 'contact-profile-restate'
		case 'bulkIngest':
			return 'kit-directory-ingest'
		case 'bulkBackfill':
			return 'contact-sync-backfill'
		case 'bulk':
			// Legacy outbox rows have no class. Known profile/link deltas must not
			// return to the old backfill backlog; retain conservative pacing otherwise.
			if (row.idempotencyKey.includes(':restate:'))
				return 'contact-profile-restate'
			return ['contact.profile.updated', 'contact.links.issued'].includes(
				row.eventType ?? '',
			)
				? 'contact-profile-sync'
				: 'contact-sync-backfill'
		case 'contactSync':
			return row.eventType !== 'contact.offer.issued'
				? 'contact-profile-sync'
				: undefined
		default:
			return undefined
	}
}

/** Queue owns a timed-out capped row again. It does not claim delivery, and
 * it never sleeps inside the short-lived Vercel replay step. */
export async function queueCappedReplay(
	row: DrovrOutboxRow,
	send: (envelope: DrovrDeliverEnvelope) => Promise<unknown>,
	now = Date.now(),
): Promise<DrovrOutboxPostOutcome | undefined> {
	if (row.endpoint !== 'events') return undefined
	const source = cappedSource(row)
	if (!source) return undefined
	await send({
		name: deliverEventNameFor(source),
		data: { source, events: [row.body as DrovrShadowEvent] },
	})
	return {
		kind: 'queued',
		nextAttemptAt: new Date(now + BULK_OUTBOX_QUEUE_WAIT_MS).toISOString(),
	}
}
