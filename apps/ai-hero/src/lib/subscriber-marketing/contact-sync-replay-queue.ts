import { randomUUID } from 'node:crypto'
import { assertOutboxWireRow } from './drovr-outbox-wire-status'
import { readHeldContinuationEnvelope } from './drovr-outbox-control'

import {
	deliverEventNameFor,
	type DrovrEventsDeliver,
	type DrovrDeliverEnvelope,
} from '@/inngest/events/drovr'
import { BULK_OUTBOX_QUEUE_WAIT_MS } from './contact-sync-bulk'
import { DROVR_OUTBOX_MAX_QUEUE_HANDOFFS, isEventNotLiveDeferred, type DrovrOutboxPostOutcome, type DrovrOutboxRow } from './drovr-outbox'
import type { DrovrShadowEvent } from './drovr-shadow-emitter'

function cappedSource(
	row: DrovrOutboxRow,
): DrovrEventsDeliver['data']['source'] | undefined {
	// The legacy contact-sync source also owns genuine offer-only failures.
	if (row.source === 'contactSync' && row.eventType === 'contact.offer.issued') return undefined
	switch (row.source) {
		case 'bulkDelta':
			return 'contact-profile-sync'
		case 'bulkRestate':
			return 'contact-profile-restate'
		case 'bulkIngest':
			return 'kit-directory-ingest'
		case 'bulkBackfill':
			return 'contact-sync-backfill'
		case 'bulkEvergreen':
			return 'evergreen-pitch-backfill'
		case 'contactSync':
		case 'onFailure':
		case 'fallback':
		case 'bulk':
			// Lost producer metadata never makes native backfill profile-only.
			// Only actual profile/link facts can be recognized as restatements;
			// an unrelated native key containing that text is not a class proof.
			if (['contact.profile.updated', 'contact.links.issued'].includes(row.eventType ?? ''))
				return row.idempotencyKey.includes(':restate:') ? 'contact-profile-restate' : 'contact-profile-sync'
			return 'evergreen-pitch-backfill'
		default:
			return undefined
	}
}

/** Queue owns a timed-out capped row again. It does not claim delivery, and
 * it never sleeps inside the short-lived Vercel replay step. */
export async function queueCappedReplay(
	row: DrovrOutboxRow,
	send: (envelope: DrovrDeliverEnvelope) => Promise<unknown>,
	now: number,
	lease: (until: string, expectedUntil: string | undefined, publicationId: string) => Promise<boolean>,
	abort: (publicationId: string) => Promise<void>,
	/** Only a strictly decoded, explicitly released coordinator supplies this. */
	publishContinuation?: () => Promise<unknown>,
): Promise<DrovrOutboxPostOutcome | undefined> {
	assertOutboxWireRow(row)
	if (row.endpoint !== 'events') return undefined
	const source = cappedSource(row)
	if (!source && !publishContinuation) return undefined
	if (row.queuePublicationId) return { kind: 'held', detail: 'QueuePublicationUnknown: you resumed capped replay, and it stopped because an earlier durable publication claim has no recorded completion. Accepted: a recorded broker-call outcome. Fix: inspect the prior SDK run before clearing the claim and releasing the original bytes. Debug: inspect the publication ID and retained diagnostic; no new HTTP or publication was sent.' }
	if (row.queueMetadataInvalid) return { kind: 'held', detail: 'QueueMetadata: you requested replay, and it stopped because the retained handoff proof is malformed. Accepted: valid queue metadata with the original diagnostic. Fix: inspect and repair the retained metadata before releasing. Debug: inspect the row and the prior broker receipts; no HTTP was sent.' }
	if ((row.queueHandoffs ?? 0) >= DROVR_OUTBOX_MAX_QUEUE_HANDOFFS && !isEventNotLiveDeferred(row)) return { kind: 'held', detail: 'QueueHandoff: you replayed capped work, and it stopped because the successful handoff budget is exhausted without delivery. Accepted: at most eight successful queue handoffs; explicit receiver event-not-live remains deferred. Fix: inspect the failed consumer and release the original bytes deliberately. Debug: inspect attempts, the SDK run and the retained diagnostic.' }
	const ack = ['contact.profile.updated', 'contact.links.issued'].includes(row.eventType ?? '') ? readHeldContinuationEnvelope(row.heldContinuation)?.profileAck : undefined
	const ackSdk = ack && (ack.role === 'coordinator' || ack.role === 'member') ? { profileAckRef: ack.ref, profileAckNativeDebt: true } : {}
	const publicationId = randomUUID()
	const until = new Date(now + BULK_OUTBOX_QUEUE_WAIT_MS).toISOString()
	try {
		if (!await lease(until, undefined, publicationId)) return { kind: 'queued', phase: 'stale' }
	} catch {
		return { kind: 'queued', phase: 'deferred', detail: 'QueueOwnership: you requested capped replay, and it failed because the durable lease was unavailable. Accepted: a writable outbox. Fix: restore storage before replay. Debug: inspect the row ID and replay run; no HTTP was sent.' }
	}
	try {
		if (publishContinuation) await publishContinuation()
		else if (source) await send({
			name: deliverEventNameFor(source),
			data: { source, events: [row.body as DrovrShadowEvent], firstFailedAt: row.firstFailedAt, ...ackSdk },
		})
	} catch {
		const retryAt = new Date(now + 60_000).toISOString()
		let released = false
		try { released = await lease(retryAt, until, publicationId) } catch { /* retain ownership; never fabricate a successful release */ }
		if (!released) { try { await abort(publicationId) } catch { /* retain the ambiguous claim for a human, never clear a newer one */ } }
		return { kind: 'queued', phase: 'deferred', ...(released ? { nextAttemptAt: retryAt } : {}), detail: 'QueuePublication: you requested capped replay, and it failed because the broker handoff was unavailable. Accepted: a healthy Inngest event API. Fix: restore the broker and allow the retained row to retry. Debug: inspect the row ID and replay run; the original Drovr diagnostic is unchanged.' }
	}
	return { kind: 'queued', phase: 'published', publicationId, nextAttemptAt: until }
}
