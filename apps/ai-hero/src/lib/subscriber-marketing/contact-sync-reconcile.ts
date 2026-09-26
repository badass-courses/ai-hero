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
	/**
	 * ContactEvents with after < occurredAt <= through (and, when given,
	 * written after `writtenAfter`), by (occurredAt, id), at most limit + 1.
	 * `scope` names the scan (each is its own step).
	 */
	scanChanges(args: {
		scope: 'fresh' | 'overlap'
		writtenAfter?: string
		after: string
		through: string
		limit: number
	}): Promise<ScannedContactEvent[]>
	/**
	 * Contacts whose links reached a 90-day step in (after, through], each
	 * with the instant the step fell, by that instant, at most limit + 1.
	 */
	rotatedContacts(args: {
		after: string
		through: string
		limit: number
	}): Promise<{ contactId: string; at: string }[]>
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
		/** How far behind the watermark to look for late writes. */
		lateWriteWindowMs?: number
		settleMs?: number
	} = {},
): Promise<ContactSyncReconcileReceipt> {
	const limit = options.limit ?? 5000
	const maxContacts = options.maxContacts ?? 400
	const overlapMs = options.overlapMs ?? HOUR_MS
	// Prod, the 7 days to 2026-09-26: 335 of 2195 signups were written over
	// an hour after their occurredAt (confirmation reconciler re-entries),
	// none over a day. Twice that, on the occurredAt index.
	const lateWriteWindowMs = options.lateWriteWindowMs ?? 48 * HOUR_MS
	// Writes still in flight at the start must not fall behind the claim.
	const settleMs = options.settleMs ?? 2 * MINUTE_MS
	const planned = iso(ports.now().getTime() - settleMs)
	const watermark = await ports.readWatermark()
	// A first run starts one overlap back and has nothing to overlap; the
	// backfill owns history.
	const last = watermark ?? iso(Date.parse(planned) - overlapMs)

	// Fresh changes decide the claim. The overlap looks behind the watermark
	// only for late writes: rows under an old occurredAt written after the
	// watermark was claimed, which the previous scan could not have seen.
	// Every one of them is synced (their budget comes first), and they never
	// move the claim, which stays ahead of the watermark (the cursor only
	// moves forward). Too many to cover means no advance.
	const fresh = await ports.scanChanges({
		scope: 'fresh',
		after: last,
		through: planned,
		limit,
	})
	const overlap = watermark
		? await ports.scanChanges({
				scope: 'overlap',
				after: iso(Date.parse(watermark) - lateWriteWindowMs),
				through: watermark,
				writtenAfter: watermark,
				limit,
			})
		: []
	if (overlap.length > limit) {
		throw new Error(
			`contact sync reconcile cannot advance: over ${limit} late writes behind ${watermark}`,
		)
	}
	const late = [...new Set(overlap.map((row) => row.contactId))]
	if (late.length > maxContacts) {
		throw new Error(
			`contact sync reconcile cannot advance: ${late.length} contacts with late writes exceed ${maxContacts}`,
		)
	}
	const rotations = await ports.rotatedContacts({
		after: last,
		through: planned,
		limit: maxContacts,
	})

	let claim = planned
	if (fresh.length > limit)
		claim = earlier(
			claim,
			claimBefore(fresh[limit]!.occurredAt, last, `over ${limit} events`),
		)
	if (rotations.length > maxContacts)
		claim = earlier(
			claim,
			claimBefore(
				rotations[maxContacts]!.at,
				last,
				`over ${maxContacts} rotations`,
			),
		)

	// One timeline of fresh events and rotation steps, capped in time order.
	const timeline = [
		...fresh.map((row) => ({ contactId: row.contactId, at: row.occurredAt })),
		...rotations.map((row) => ({ contactId: row.contactId, at: row.at })),
	]
		.filter((item) => Date.parse(item.at) <= Date.parse(claim))
		.sort((left, right) => Date.parse(left.at) - Date.parse(right.at))
	const claimed = new Set<string>(late)
	for (const item of timeline) {
		if (claimed.has(item.contactId)) continue
		if (claimed.size === maxContacts) {
			claim = earlier(
				claim,
				claimBefore(item.at, last, `over ${maxContacts} contacts`),
			)
			break
		}
		claimed.add(item.contactId)
	}
	const within = (at: string) => Date.parse(at) <= Date.parse(claim)
	const freshEvents = fresh.filter((row) => within(row.occurredAt))
	const contacts = [
		...new Set([
			...late,
			...timeline
				.filter((item) => within(item.at))
				.map((item) => item.contactId),
		]),
	]
	const rotated = new Set(
		rotations.filter((row) => within(row.at)).map((row) => row.contactId),
	)
	const synced = new Set(contacts)

	for (let index = 0; index < contacts.length; index += SYNC_CHUNK) {
		await Promise.all(
			contacts
				.slice(index, index + SYNC_CHUNK)
				.map((contactId) => ports.syncContact(contactId)),
		)
	}
	const stops = [...freshEvents, ...overlap].filter(
		(row) =>
			synced.has(row.contactId) &&
			CONTACT_SYNC_STOP_EVENT_TYPES.has(row.eventType),
	)
	await ports.resendStops(stops)

	await ports.heartbeat(claim)
	await ports.writeWatermark(claim)
	return {
		status: 'synced',
		syncedThrough: claim,
		contacts: contacts.length,
		rotated: rotated.size,
		events:
			freshEvents.length +
			overlap.filter((row) => synced.has(row.contactId)).length,
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
function claimBefore(split: string, after: string, cause: string): string {
	const claim = iso(Date.parse(split) - 1)
	if (Date.parse(claim) <= Date.parse(after)) {
		throw new Error(
			`contact sync reconcile cannot advance past ${after}: ${cause} share one second`,
		)
	}
	return claim
}

function earlier(left: string, right: string): string {
	return Date.parse(left) <= Date.parse(right) ? left : right
}

function iso(ms: number): string {
	return new Date(ms).toISOString()
}
