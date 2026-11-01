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
 *
 * Late writes over maxContacts (2026-10-30: 3,014 rows from one backfill
 * wedged it) drain across runs behind a second cursor, in write order,
 * maxContacts contacts a run, holding the watermark until they fit.
 */

export type ScannedContactEvent = {
	id: string
	contactId: string
	eventType: string
	occurredAt: string
	/** Set when the scan runs in write order (`lateCursor`). */
	createdAt?: string
}

/** A late row's place in write order: (createdAt, id). */
export type ContactSyncLatePosition = { createdAt: string; id: string }

/**
 * Where the late drain stands. `after` is the last late row synced, in
 * write order; `failing` is the head contact holding it there and how many
 * runs in a row it failed.
 */
export type ContactSyncLateCursor = {
	after?: ContactSyncLatePosition
	failing?: { contactId: string; runs: number }
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
		/**
		 * Late-cursor mode: by (createdAt, id) instead, past `after` when
		 * given, each row with its createdAt.
		 */
		lateCursor?: { after?: ContactSyncLatePosition }
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
	syncContact(contactId: string): Promise<'sent' | 'skipped' | 'deferred'>
	/** Re-sends the live path's stop facts for these events, under the same keys. */
	resendStops(events: ScannedContactEvent[]): Promise<void>
	heartbeat(syncedThrough: string): Promise<void>
	/** Stamps its own heartbeatAt. */
	writeWatermark(watermark: string): Promise<void>
	/**
	 * The late drain's cursor. Without it, more late contacts than
	 * maxContacts refuse the run, as before the drain.
	 */
	lateCursor?: {
		read(): Promise<ContactSyncLateCursor | undefined>
		/** `undefined` clears it. */
		write(cursor: ContactSyncLateCursor | undefined): Promise<void>
		/** The page: a late contact skipped after failing too many runs. */
		skipped(skip: {
			contactId: string
			eventType: string
			reason: string
		}): Promise<void>
	}
}

export type ContactSyncReconcileReceipt = {
	/**
	 * `partial`: some contacts failed; the claim stops before the first.
	 * `draining`: only late writes were synced; `syncedThrough` is the
	 * watermark, unmoved.
	 */
	status: 'synced' | 'partial' | 'draining'
	syncedThrough: string
	contacts: number
	rotated: number
	events: number
	failed?: string[]
	/** Late contacts given up on after LATE_SKIP_RUNS failing runs. */
	lateSkipped?: string[]
	/** Draining: where the late cursor now stands. */
	lateThrough?: ContactSyncLatePosition
}

/** ai-hero ContactEvents whose live mapping is a stop fact (drovr-shadow-emitter). */
export const CONTACT_SYNC_STOP_EVENT_TYPES: ReadonlySet<string> = new Set([
	'contact.unsubscribed',
	// Directory stops only (mig-10, 2026-09-27): drovr's suppression row.
	'contact.bounced',
	'contact.complained',
])

const SYNC_CHUNK = 10
/** Runs in a row a head late contact may fail before it is skipped. */
export const LATE_SKIP_RUNS = 3
const HOUR_MS = 60 * 60 * 1000
const MINUTE_MS = 60 * 1000
const DAY_MS = 24 * HOUR_MS

export async function runContactSyncReconcile(
	ports: ContactSyncReconcilePorts,
	options: {
		limit?: number
		/** Each contact is one step; a run has a step budget. */
		maxContacts?: number
		/**
		 * Contacts sharing one instant are taken whole past maxContacts (a
		 * cut inside a tie could never advance), up to this ceiling, which
		 * stays under the run's step limit.
		 */
		maxContactsHard?: number
		overlapMs?: number
		/** How far behind the watermark to look for late writes. */
		lateWriteWindowMs?: number
		settleMs?: number
	} = {},
): Promise<ContactSyncReconcileReceipt> {
	const limit = options.limit ?? 5000
	const maxContacts = options.maxContacts ?? 400
	const maxContactsHard = options.maxContactsHard ?? 900
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
	// Late writes exist only behind a watermark.
	const lateCursor = watermark ? ports.lateCursor : undefined
	const cursor = lateCursor ? await lateCursor.read() : undefined

	// Fresh changes decide the claim. The overlap looks behind the watermark
	// only for late writes: rows under an old occurredAt written after the
	// watermark was claimed, which the previous scan could not have seen.
	// Every one of them is synced (their budget comes first), and they never
	// move the claim, which stays ahead of the watermark (the cursor only
	// moves forward). Too many for one run drain across runs first, with no
	// advance until they fit (without a late cursor port, no advance at all).
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
				...(lateCursor ? { lateCursor: { after: cursor?.after } } : {}),
			})
		: []
	const late = [...new Set(overlap.map((row) => row.contactId))]
	// More than one run can cover: drain them, in write order, first.
	if (lateCursor && (overlap.length > limit || late.length > maxContacts))
		return drainLate(ports, lateCursor, {
			cursor,
			overlap,
			maxContacts,
			planned,
			watermark: watermark!,
		})
	if (overlap.length > limit) {
		throw new Error(
			`contact sync reconcile cannot advance: over ${limit} late writes behind ${watermark}`,
		)
	}
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
	// The store ends an overflowing answer with a whole tie group, so every
	// rotation at or before its last instant is here: claim that instant.
	if (rotations.length > maxContacts)
		claim = earlier(claim, rotations[rotations.length - 1]!.at)

	// One timeline of fresh events and rotation steps, capped in time order.
	const timeline = [
		...fresh.map((row) => ({ contactId: row.contactId, at: row.occurredAt })),
		...rotations.map((row) => ({ contactId: row.contactId, at: row.at })),
	]
		.filter((item) => Date.parse(item.at) <= Date.parse(claim))
		.sort((left, right) => Date.parse(left.at) - Date.parse(right.at))
	const claimed = new Set<string>(late)
	let previousAt: string | undefined
	for (const item of timeline) {
		const tie =
			previousAt !== undefined && Date.parse(item.at) === Date.parse(previousAt)
		previousAt = item.at
		if (claimed.has(item.contactId)) continue
		if (claimed.size >= maxContacts) {
			if (!tie) {
				claim = earlier(
					claim,
					claimBefore(item.at, last, `over ${maxContacts} contacts`),
				)
				break
			}
			if (claimed.size >= maxContactsHard) {
				throw new Error(
					`contact sync reconcile cannot advance: more than ${maxContactsHard} contacts share one instant (${item.at})`,
				)
			}
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
	// Contract §3: a push that failed (anything but an answer) holds the
	// heartbeat at the last instant before that contact's first change here.
	const failures = await syncContacts(ports, contacts)
	const failed = new Set(failures.map((failure) => failure.contactId))
	// A failed late write holds everything, as ever, but now through the
	// late cursor, which counts its runs and skips it on the last one. The
	// cursor never passes a stop row before that stop went out: the next
	// scan would never see it again.
	const settled = lateCursor
		? settleLate(overlap, failed, cursor, planned)
		: undefined
	const lateSkipped = new Set(
		settled?.skipped.map((skip) => skip.contactId) ?? [],
	)
	const passed = new Set(settled?.passed.map((row) => row.id) ?? [])
	const holding = settled?.failing?.contactId
	if (lateCursor && settled && holding) {
		const passedStops = settled.passed.filter(isStop)
		if (passedStops.length > 0) await ports.resendStops(passedStops)
		await reportLateSkips(lateCursor, settled.skipped)
		await lateCursor.write(lateCursorOf(settled))
		throw failures.find((failure) => failure.contactId === holding)!.reason
	}
	if (failures.length > 0) {
		// A late write sits behind the watermark; otherwise the contact's
		// first change in this run's timeline. A skipped late contact holds
		// only through its fresh changes, if any.
		const firstChange = (contactId: string): string | undefined =>
			late.includes(contactId) && !lateSkipped.has(contactId)
				? last
				: timeline.find(
						(item) => item.contactId === contactId && within(item.at),
					)?.at
		const holds = [...failed]
			.map(firstChange)
			.filter((at): at is string => at !== undefined)
		if (holds.length > 0) {
			const earliest = holds.reduce((left, right) => earlier(left, right))
			const held = iso(Date.parse(earliest) - 1)
			if (Date.parse(held) <= Date.parse(last)) throw failures[0]!.reason
			claim = earlier(claim, held)
		}
	}
	const synced = new Set(contacts.filter((contactId) => !failed.has(contactId)))
	// A skipped contact's late stops go out too: the cursor passes them.
	const stops = [...freshEvents, ...overlap].filter(
		(row) =>
			(synced.has(row.contactId) ||
				(lateSkipped.has(row.contactId) && passed.has(row.id))) &&
			isStop(row),
	)
	await ports.resendStops(stops)
	// Recorded once its stops are out, so a later throw keeps the skip.
	let lateCursorWritten = false
	if (lateCursor && settled && settled.skipped.length > 0) {
		await reportLateSkips(lateCursor, settled.skipped)
		await lateCursor.write(lateCursorOf(settled))
		lateCursorWritten = true
	}

	await ports.heartbeat(claim)
	await ports.writeWatermark(claim)
	// The next overlap starts at the new watermark, so the drain is over.
	if (lateCursor && (cursor || lateCursorWritten))
		await lateCursor.write(undefined)
	return {
		status: failed.size > 0 ? 'partial' : 'synced',
		syncedThrough: claim,
		contacts: contacts.length,
		rotated: rotated.size,
		events:
			freshEvents.length +
			overlap.filter((row) => synced.has(row.contactId)).length,
		...(failed.size > 0 ? { failed: [...failed].sort() } : {}),
		...(lateSkipped.size > 0 ? { lateSkipped: [...lateSkipped].sort() } : {}),
	}
}

/**
 * A draining run: the oldest late writes, through maxContacts contacts,
 * then the late cursor. No fresh contacts, no rotations, no heartbeat and
 * no watermark; the stops of the late rows synced, and of every row the
 * cursor passes, still go out first.
 */
async function drainLate(
	ports: ContactSyncReconcilePorts,
	lateCursor: NonNullable<ContactSyncReconcilePorts['lateCursor']>,
	args: {
		cursor: ContactSyncLateCursor | undefined
		overlap: ScannedContactEvent[]
		maxContacts: number
		planned: string
		watermark: string
	},
): Promise<ContactSyncReconcileReceipt> {
	const batch: ScannedContactEvent[] = []
	const contacts = new Set<string>()
	for (const row of args.overlap) {
		// A row written inside the settle may sit behind one still in flight.
		if (Date.parse(writtenAt(row)) > Date.parse(args.planned)) break
		if (!contacts.has(row.contactId)) {
			if (contacts.size >= args.maxContacts) break
			contacts.add(row.contactId)
		}
		batch.push(row)
	}
	const failures = await syncContacts(ports, [...contacts])
	const failed = new Set(failures.map((failure) => failure.contactId))
	const settled = settleLate(batch, failed, args.cursor, args.planned)
	const synced = batch.filter((row) => !failed.has(row.contactId))
	const passed = new Set(settled.passed.map((row) => row.id))
	await ports.resendStops(
		batch.filter(
			(row) =>
				(!failed.has(row.contactId) || passed.has(row.id)) && isStop(row),
		),
	)
	await reportLateSkips(lateCursor, settled.skipped)
	await lateCursor.write(lateCursorOf(settled))
	return {
		status: 'draining',
		syncedThrough: args.watermark,
		contacts: contacts.size,
		rotated: 0,
		events: synced.length,
		...(failed.size > 0 ? { failed: [...failed].sort() } : {}),
		...(settled.skipped.length > 0
			? {
					lateSkipped: settled.skipped.map((skip) => skip.contactId).sort(),
				}
			: {}),
		...(settled.after ? { lateThrough: settled.after } : {}),
	}
}

type SettledLate = {
	after?: ContactSyncLatePosition
	failing?: { contactId: string; runs: number }
	skipped: { contactId: string; eventType: string }[]
	/** The rows `after` moved over this run, in order. */
	passed: ScannedContactEvent[]
}

/**
 * How far the late cursor moves over rows in write order: through the last
 * settled row before the first whose contact failed. That contact holds it;
 * failing LATE_SKIP_RUNS runs in a row, it is skipped instead (its next live
 * change resyncs it) and the walk goes on.
 */
function settleLate(
	rows: readonly ScannedContactEvent[],
	failed: ReadonlySet<string>,
	cursor: ContactSyncLateCursor | undefined,
	planned: string,
): SettledLate {
	let after = cursor?.after
	let moving = true
	const skipped: SettledLate['skipped'] = []
	const passed: ScannedContactEvent[] = []
	for (const row of rows) {
		const skippedAlready = skipped.some(
			(skip) => skip.contactId === row.contactId,
		)
		if (failed.has(row.contactId) && !skippedAlready) {
			const runs =
				cursor?.failing?.contactId === row.contactId
					? cursor.failing.runs + 1
					: 1
			if (runs < LATE_SKIP_RUNS)
				return {
					after,
					failing: { contactId: row.contactId, runs },
					skipped,
					passed,
				}
			skipped.push({ contactId: row.contactId, eventType: row.eventType })
		}
		if (Date.parse(writtenAt(row)) > Date.parse(planned)) moving = false
		if (moving) {
			after = { createdAt: writtenAt(row), id: row.id }
			passed.push(row)
		}
	}
	return { after, skipped, passed }
}

function isStop(row: ScannedContactEvent): boolean {
	return CONTACT_SYNC_STOP_EVENT_TYPES.has(row.eventType)
}

function lateCursorOf(settled: SettledLate): ContactSyncLateCursor {
	return {
		...(settled.after ? { after: settled.after } : {}),
		...(settled.failing ? { failing: settled.failing } : {}),
	}
}

async function reportLateSkips(
	lateCursor: NonNullable<ContactSyncReconcilePorts['lateCursor']>,
	skipped: SettledLate['skipped'],
): Promise<void> {
	for (const skip of skipped)
		await lateCursor.skipped({
			...skip,
			reason: `sync failed ${LATE_SKIP_RUNS} runs in a row`,
		})
}

function writtenAt(row: ScannedContactEvent): string {
	if (!row.createdAt)
		throw new Error(`late row ${row.id} came back without its createdAt`)
	return row.createdAt
}

/** Every contact's sync, SYNC_CHUNK at a time; the ones that threw. */
async function syncContacts(
	ports: ContactSyncReconcilePorts,
	contacts: readonly string[],
): Promise<{ contactId: string; reason: unknown }[]> {
	const failures: { contactId: string; reason: unknown }[] = []
	for (let index = 0; index < contacts.length; index += SYNC_CHUNK) {
		const chunk = contacts.slice(index, index + SYNC_CHUNK)
		const results = await Promise.allSettled(
			chunk.map((contactId) => ports.syncContact(contactId)),
		)
		results.forEach((result, position) => {
			if (result.status === 'rejected')
				failures.push({ contactId: chunk[position]!, reason: result.reason })
		})
	}
	return failures
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
	// Outside drovr's contact-sync scope (no sending journey).
	'no-sending-journey',
	// drovr would ignore a profile without an email as malformed.
	'contact-email-missing',
	// Contract §4: final for that event, logged; an answer, not a failure.
	'drovr-rejected',
	// Held on purpose: an unsubscribed contact is never pushed, and its stop
	// travels on its own path. Throwing here retried one contact forever.
	'unsubscribed-held',
	// Byte-identical to the last push; drovr already has it.
	'unchanged',
])

/**
 * What one contact's sync receipt means for the watermark: sent, or a skip
 * with nothing to push, counts; anything else (drovr not configured, the
 * flag off) means the change did not land, so the run must not advance.
 */
export function reconcileSyncOutcome(
	contactId: string,
	receipt: ContactProfileSyncReceipt,
): 'sent' | 'skipped' | 'deferred' {
	if (receipt.status === 'sent') return 'sent'
	// Contract §3: refused as event-not-live (or cold-start-unhandled), the
	// same events are already scheduled for after drovr's straggler pass.
	if (receipt.status === 'deferred') return 'deferred'
	if (BENIGN_SYNC_SKIPS.has(receipt.reason)) return 'skipped'
	throw new Error(
		`profile sync for ${contactId} was not pushed: ${receipt.reason}`,
	)
}

/**
 * Links re-issue every 90 days from their first issue. A step fell in
 * (after, through] exactly when the first issue sits in (after, through]
 * moved back by a whole number of steps. The store asks for as many steps
 * as its oldest anchor needs, so no anchor is too old to rotate.
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
