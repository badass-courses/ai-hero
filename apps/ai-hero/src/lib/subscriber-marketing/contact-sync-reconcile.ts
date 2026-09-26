import type { ContactProfileSyncReceipt } from './drovr-contact-profile-sync'
import {
	mapDrovrShadowFact,
	type DrovrShadowEvent,
} from './drovr-shadow-emitter'
import type { ContactEventRecord } from './types'
import { VALUE_PATH_LINK_REISSUE_EVERY_DAYS } from './value-path-link-anchor'

/**
 * Contact sync (2026-09-26), PR 3: the reconcile behind drovr's freshness
 * guard. Every run pushes each contact whose ContactEvents moved since the
 * last watermark (less an hour of overlap) plus each contact whose answer
 * links reached a 90-day step, re-sends ai-hero's own stop facts, and only
 * then tells drovr, through the heartbeat, that everything up to its
 * watermark has landed. Any failure leaves the watermark where it was, so
 * the next run pushes it again: a change is delayed, never lost.
 *
 * Every profile input either writes a ContactEvent (scanned here, all types,
 * on the occurredAt index) or asks for a sync where it is written; the
 * table in the PR lists each writer.
 */

export type ScannedContactEvent = {
	id: string
	contactId: string
	eventType: string
	occurredAt: string
}

export type ContactSyncReconcilePorts = {
	/** Read once per run; under Inngest it comes from a memoized step. */
	now: () => Date
	readWatermark(): Promise<string | undefined>
	/** ContactEvents with after < occurredAt <= through, by (occurredAt, id), at most limit + 1. */
	scanChanges(args: {
		after: string
		through: string
		limit: number
	}): Promise<ScannedContactEvent[]>
	/** Contacts whose first link issue sits in one of linkRotationRanges. */
	rotatedContacts(args: { after: string; through: string }): Promise<string[]>
	/** Resolves only once drovr has the contact's profile; 'skipped' when there is none to push. */
	syncContact(contactId: string): Promise<'sent' | 'skipped'>
	/** Re-sends the live path's stop facts for these events, under the same keys. */
	resendStops(events: ScannedContactEvent[]): Promise<void>
	heartbeat(syncedThrough: string): Promise<void>
	/** Stamps its own heartbeatAt. */
	writeWatermark(watermark: string): Promise<void>
}

export type ContactSyncReconcileReceipt = {
	status: 'synced'
	syncedThrough: string
	contacts: number
	rotated: number
	events: number
}

/** ai-hero ContactEvents whose live mapping is a stop fact (drovr-shadow-emitter). */
export const CONTACT_SYNC_STOP_EVENT_TYPES: ReadonlySet<string> = new Set([
	'contact.unsubscribed',
])

const SYNC_CHUNK = 10
const HOUR_MS = 60 * 60 * 1000
const MINUTE_MS = 60 * 1000
const DAY_MS = 24 * HOUR_MS

export async function runContactSyncReconcile(
	ports: ContactSyncReconcilePorts,
	options: {
		limit?: number
		/** Each contact is one step; a run has a step budget. */
		maxContacts?: number
		overlapMs?: number
		settleMs?: number
	} = {},
): Promise<ContactSyncReconcileReceipt> {
	const limit = options.limit ?? 5000
	const maxContacts = options.maxContacts ?? 400
	const overlapMs = options.overlapMs ?? HOUR_MS
	// Writes still in flight at the start must not fall behind the claim.
	const settleMs = options.settleMs ?? 2 * MINUTE_MS
	const planned = iso(ports.now().getTime() - settleMs)
	const watermark = await ports.readWatermark()
	// A first run starts one overlap back; the backfill owns history.
	const last = watermark ?? iso(Date.parse(planned) - overlapMs)
	const after = watermark ? iso(Date.parse(watermark) - overlapMs) : last

	const scanned = await ports.scanChanges({ after, through: planned, limit })
	let syncedThrough = planned
	let events = scanned
	if (scanned.length > limit) {
		// Claim only the whole seconds the scan covered (occurredAt is
		// second-precision); the overlap re-scans the rest next run.
		syncedThrough = claimBefore(scanned[limit]!, after, `over ${limit} events`)
		events = scanned.filter(
			(row) => Date.parse(row.occurredAt) <= Date.parse(syncedThrough),
		)
	}
	const seen = new Set<string>()
	const firstOverCap = events.find((row) => {
		seen.add(row.contactId)
		return seen.size > maxContacts
	})
	if (firstOverCap) {
		syncedThrough = claimBefore(
			firstOverCap,
			after,
			`over ${maxContacts} contacts`,
		)
		events = events.filter(
			(row) => Date.parse(row.occurredAt) <= Date.parse(syncedThrough),
		)
	}

	const rotated = await ports.rotatedContacts({
		after: last,
		through: syncedThrough,
	})
	const contacts = [
		...new Set([...events.map((row) => row.contactId), ...rotated]),
	]
	for (let index = 0; index < contacts.length; index += SYNC_CHUNK) {
		await Promise.all(
			contacts
				.slice(index, index + SYNC_CHUNK)
				.map((contactId) => ports.syncContact(contactId)),
		)
	}
	const stops = events.filter((row) =>
		CONTACT_SYNC_STOP_EVENT_TYPES.has(row.eventType),
	)
	await ports.resendStops(stops)

	await ports.heartbeat(syncedThrough)
	await ports.writeWatermark(syncedThrough)
	return {
		status: 'synced',
		syncedThrough,
		contacts: contacts.length,
		rotated: rotated.length,
		events: events.length,
	}
}

/**
 * The live dispatch's own facts for the scanned stop events, so a re-send
 * carries the same keys and drovr dedupes what already landed.
 */
export async function stopFactsFor(
	repository: {
		findContactEventsByType(
			contactId: string,
			eventType: string,
		): Promise<ContactEventRecord[]> | ContactEventRecord[]
	},
	stops: readonly ScannedContactEvent[],
): Promise<DrovrShadowEvent[]> {
	const facts: DrovrShadowEvent[] = []
	for (const stop of stops) {
		const records = await repository.findContactEventsByType(
			stop.contactId,
			stop.eventType,
		)
		const record = records.find((candidate) => candidate.id === stop.id)
		if (record)
			facts.push(
				...mapDrovrShadowFact({ kind: 'contact-event', event: record }),
			)
	}
	return facts
}

/** Skips that mean there is nothing to push for the contact. */
const BENIGN_SYNC_SKIPS: ReadonlySet<string> = new Set([
	'contact-missing',
	'synthetic-principal',
])

/**
 * What one contact's sync receipt means for the watermark: sent, or a skip
 * with nothing to push, counts; anything else (drovr not configured, the
 * flag off) means the change did not land, so the run must not advance.
 */
export function reconcileSyncOutcome(
	contactId: string,
	receipt: ContactProfileSyncReceipt,
): 'sent' | 'skipped' {
	if (receipt.status === 'sent') return 'sent'
	if (BENIGN_SYNC_SKIPS.has(receipt.reason)) return 'skipped'
	throw new Error(
		`profile sync for ${contactId} was not pushed: ${receipt.reason}`,
	)
}

/**
 * Links re-issue every 90 days from their first issue. A step fell in
 * (after, through] exactly when the first issue sits in (after, through]
 * moved back by a whole number of steps; five steps cover 450 days, past
 * which a path has long finished.
 */
export function linkRotationRanges(
	args: { after: string; through: string },
	steps = 5,
): { after: string; through: string }[] {
	const stepMs = VALUE_PATH_LINK_REISSUE_EVERY_DAYS * DAY_MS
	return Array.from({ length: steps }, (_, index) => ({
		after: iso(Date.parse(args.after) - (index + 1) * stepMs),
		through: iso(Date.parse(args.through) - (index + 1) * stepMs),
	}))
}

/**
 * The claim stops short of the second `split` falls in (occurredAt is
 * second-precision), so every event claimed was covered; the overlap
 * re-scans the rest next run.
 */
function claimBefore(
	split: ScannedContactEvent,
	after: string,
	cause: string,
): string {
	const claim = iso(Date.parse(split.occurredAt) - 1)
	if (Date.parse(claim) <= Date.parse(after)) {
		throw new Error(
			`contact sync reconcile cannot advance past ${after}: ${cause} share one second`,
		)
	}
	return claim
}

function iso(ms: number): string {
	return new Date(ms).toISOString()
}
