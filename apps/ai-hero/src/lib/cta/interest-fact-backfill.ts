import { createHash } from 'node:crypto'
import { open, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
	INTEREST_FACT_REQUESTED_EVENT,
	type InterestFactRequested,
} from '@/inngest/events/interest-fact'
import type { DrovrContactResolution } from '@/lib/subscriber-marketing/drovr-purchase-resolve'

import { isInterestFieldKey, type InterestFieldKey } from './interest-facts'

/**
 * A one-off backfill of Kit's waitlist and interest holders as owned facts,
 * so the owned count can match Kit's before `AIH_INTEREST_KIT_WRITES=off`.
 *
 * It reads a Kit subscriber export line by line and, with `--send`, queues
 * the same `aihero/interest.fact.requested` event a live join queues, with
 * `via: 'backfill'` and Kit's date. The record function does the writing, so
 * a backfilled fact and a live one share a drovr source id. Nothing here
 * writes Kit, the database or drovr. Output is counts only.
 */

/** The keys Kit still writes on a live join. Anything else is refused. */
export const BACKFILL_FIELD_KEYS = [
	'waitlist_software_factories_for_real_engineers',
	'interest_ai_coding_crash_course',
	'interest_ai_skills_for_real_engineers',
	'interest_workshop_2ozd9',
] as const satisfies readonly InterestFieldKey[]

export class BackfillRefused extends Error {
	constructor(reason: string) {
		super(reason)
		this.name = 'BackfillRefused'
	}
}

/** `--keys a,b`, or every live key. A key that is not live is refused. */
export function backfillKeys(raw?: string): InterestFieldKey[] {
	if (raw === undefined) return [...BACKFILL_FIELD_KEYS]
	const keys = Array.from(
		new Set(
			raw
				.split(',')
				.map((key) => key.trim())
				.filter(Boolean),
		),
	)
	if (keys.length === 0) throw new BackfillRefused('no field keys given')
	for (const key of keys) {
		if (
			!isInterestFieldKey(key) ||
			!(BACKFILL_FIELD_KEYS as readonly string[]).includes(key)
		) {
			throw new BackfillRefused(`refused field key ${key}: not a live key`)
		}
	}
	return keys as InterestFieldKey[]
}

/** One holder of one key on one export line. */
export type BackfillHolder = {
	line: number
	fieldKey: InterestFieldKey
	email: string
	state: string
	/** Undefined when neither the field nor created_at is a date. */
	expressedAt?: string
	dateSource: 'field' | 'created_at' | 'none'
}

/** The earliest date a join could carry: before Kit held any of these. */
const EARLIEST_JOIN_MS = Date.parse('2020-01-01T00:00:00Z')

function joinDate(value: unknown, nowMs: number): string | undefined {
	if (typeof value !== 'string' || !value.trim()) return undefined
	const at = Date.parse(value.trim())
	if (!Number.isFinite(at) || at < EARLIEST_JOIN_MS || at > nowMs)
		return undefined
	return new Date(at).toISOString()
}

/**
 * The holders on one export line. Kit stores a join's date as the field
 * value; when that is not a date, the subscriber's `created_at` stands in,
 * the earliest the person could have joined. A line that is not JSON or has
 * no address holds nothing.
 */
export function holdersOnLine(args: {
	line: number
	text: string
	keys: readonly InterestFieldKey[]
	nowMs: number
}): BackfillHolder[] | 'malformed' {
	// Most of a 3.8 GB export holds none of the keys; skip it unparsed.
	if (!args.keys.some((key) => args.text.includes(key))) return []
	let row: unknown
	try {
		row = JSON.parse(args.text)
	} catch {
		return 'malformed'
	}
	if (!row || typeof row !== 'object') return 'malformed'
	const { email_address, state, created_at, fields } = row as Record<
		string,
		unknown
	>
	const email = typeof email_address === 'string' ? email_address.trim() : ''
	if (!email || !fields || typeof fields !== 'object') return 'malformed'
	const holders: BackfillHolder[] = []
	for (const fieldKey of args.keys) {
		const value = (fields as Record<string, unknown>)[fieldKey]
		if (typeof value !== 'string' || !value.trim()) continue
		const fromField = joinDate(value, args.nowMs)
		const fromCreated = fromField ? undefined : joinDate(created_at, args.nowMs)
		holders.push({
			line: args.line,
			fieldKey,
			email,
			state: typeof state === 'string' && state ? state : 'unknown',
			expressedAt: fromField ?? fromCreated,
			dateSource: fromField ? 'field' : fromCreated ? 'created_at' : 'none',
		})
	}
	return holders
}

/** How much of each end of the export the fingerprint hashes. */
const FINGERPRINT_EDGE_BYTES = 1024 * 1024

export type BackfillInputFingerprint = {
	path: string
	bytes: number
	mtimeMs: number
	headSha256: string
	tailSha256: string
}

/**
 * Which export a progress file belongs to. Hashing all 3.8 GB on every start
 * is too slow, so it takes the path, size, mtime and both 1 MiB ends: a
 * different export of the same size differs in at least one of them.
 */
export async function backfillInputFingerprint(
	path: string,
): Promise<BackfillInputFingerprint> {
	const absolute = resolve(path)
	const info = await stat(absolute)
	const file = await open(absolute, 'r')
	try {
		const edge = async (position: number) => {
			const length = Math.min(FINGERPRINT_EDGE_BYTES, info.size)
			const buffer = Buffer.alloc(length)
			const { bytesRead } = await file.read(buffer, 0, length, position)
			return createHash('sha256')
				.update(buffer.subarray(0, bytesRead))
				.digest('hex')
		}
		return {
			path: absolute,
			bytes: info.size,
			mtimeMs: info.mtimeMs,
			headSha256: await edge(0),
			tailSha256: await edge(Math.max(0, info.size - FINGERPRINT_EDGE_BYTES)),
		}
	} finally {
		await file.close()
	}
}

export type BackfillProgressScope = {
	input: BackfillInputFingerprint
	keys: readonly string[]
	includeUnresolved: boolean
}

/**
 * The cursor in a saved progress file, if it belongs to this run. Any
 * difference in the export, the keys or the mode is refused by name: an old
 * cursor on a new export would skip holders and still report success.
 */
export function resumeCursor(
	saved: unknown,
	scope: BackfillProgressScope,
): number {
	const progress = saved as Partial<BackfillProgressScope & { line: number }>
	const next =
		'delete the progress file or pass the original export and flags'
	if (
		!progress ||
		typeof progress !== 'object' ||
		!progress.input ||
		!Number.isInteger(progress.line) ||
		(progress.line as number) < 0
	) {
		throw new BackfillRefused(`progress file is malformed; ${next}`)
	}
	for (const field of [
		'path',
		'bytes',
		'mtimeMs',
		'headSha256',
		'tailSha256',
	] as const) {
		if (progress.input[field] !== scope.input[field])
			throw new BackfillRefused(
				`progress file is for another export (input ${field} differs); ${next}`,
			)
	}
	if (JSON.stringify(progress.keys) !== JSON.stringify(scope.keys))
		throw new BackfillRefused(`progress file is for other keys; ${next}`)
	if (progress.includeUnresolved !== scope.includeUnresolved)
		throw new BackfillRefused(
			`progress file is for another --include-unresolved; ${next}`,
		)
	return progress.line as number
}

/** Stable per person and key, and it carries no address. */
export function backfillEventId(fieldKey: string, email: string) {
	const hash = createHash('sha256')
		.update(email.trim().toLowerCase())
		.digest('hex')
		.slice(0, 16)
	return `interest-backfill:${fieldKey}:${hash}`
}

export type BackfillEvent = InterestFactRequested & { id: string }

export function backfillEvent(
	holder: BackfillHolder & { expressedAt: string },
): BackfillEvent {
	return {
		id: backfillEventId(holder.fieldKey, holder.email),
		name: INTEREST_FACT_REQUESTED_EVENT,
		data: {
			email: holder.email,
			fieldKey: holder.fieldKey,
			expressedAt: holder.expressedAt,
			via: 'backfill',
		},
	}
}

export type BackfillClock = {
	now(): number
	sleep(ms: number): Promise<void>
}

/**
 * Paces sends to `ratePerSecond`: a batch is one second's worth (at least
 * one event), and the next batch waits until the last one's share of time
 * has passed. A slow send counts against the wait rather than adding to it.
 */
export function createPacer(ratePerSecond: number, clock: BackfillClock) {
	if (!Number.isFinite(ratePerSecond) || ratePerSecond <= 0)
		throw new BackfillRefused('rate must be a positive number')
	const batchSize = Math.max(1, Math.floor(ratePerSecond))
	let nextAt: number | undefined
	return {
		batchSize,
		/** Call before sending `count` events. */
		async before(count: number) {
			const now = clock.now()
			if (nextAt !== undefined && nextAt > now) await clock.sleep(nextAt - now)
			nextAt = Math.max(nextAt ?? now, now) + (count * 1000) / ratePerSecond
		},
	}
}

type Resolution = 'resolved' | 'missing' | 'conflict' | 'not-checked'

export type BackfillKeyCounts = {
	holders: number
	byState: Record<string, number>
	local: { resolved: number; unresolved: number }
	drovr: Record<Resolution, number>
	/** Both stores know the person: the record function will not wait. */
	resolvable: number
	date: { field: number; createdAt: number; none: number }
	sent: number
	skippedUnresolved: number
	skippedNoDate: number
}

export type BackfillReport = {
	mode: 'dry-run' | 'send'
	keys: InterestFieldKey[]
	lines: number
	malformedLines: number
	resumedFromLine: number
	lastLine: number
	stopped: boolean
	perKey: Record<string, BackfillKeyCounts>
	expressedAt: string
}

const EXPRESSED_AT_RULE =
	'the Kit field value when it parses as a date from 2020 to now; otherwise the subscriber created_at; otherwise the holder is skipped'

function emptyCounts(): BackfillKeyCounts {
	return {
		holders: 0,
		byState: {},
		local: { resolved: 0, unresolved: 0 },
		drovr: { resolved: 0, missing: 0, conflict: 0, 'not-checked': 0 },
		resolvable: 0,
		date: { field: 0, createdAt: 0, none: 0 },
		sent: 0,
		skippedUnresolved: 0,
		skippedNoDate: 0,
	}
}

export type BackfillDeps = {
	mode: 'dry-run' | 'send'
	keys: readonly InterestFieldKey[]
	lines: AsyncIterable<string>
	/** The live recorder's local resolver, read-only. */
	findContactIdForEmail(email: string): Promise<string | undefined>
	/** drovr resolve_contacts, read-only. Absent when drovr is not configured. */
	resolveDrovr?(
		emails: readonly string[],
	): Promise<Map<string, DrovrContactResolution>>
	send(events: BackfillEvent[]): Promise<void>
	stopRequested(): Promise<boolean>
	/** The last export line fully sent; 0 for a fresh run. Send mode only. */
	readCursor(): Promise<number>
	writeCursor(line: number): Promise<void>
	clock: BackfillClock
	ratePerSecond: number
	/** Also send holders a store does not know; their runs wait for them. */
	includeUnresolved?: boolean
	/** Holders resolved per round trip. */
	chunkSize?: number
	/** Local lookups in flight at once. */
	concurrency?: number
}

async function mapLimit<T, R>(
	items: readonly T[],
	limit: number,
	run: (item: T) => Promise<R>,
): Promise<R[]> {
	const results: R[] = new Array(items.length)
	let next = 0
	const workers = Array.from(
		{ length: Math.min(limit, items.length) },
		async () => {
			while (next < items.length) {
				const index = next++
				results[index] = await run(items[index]!)
			}
		},
	)
	await Promise.all(workers)
	return results
}

/**
 * The backfill run. A dry run reads the whole export and counts. A send run
 * starts after the cursor, checks the stop switch before every batch, and
 * moves the cursor past a line only once every event on it was sent, so a
 * rerun continues without resending. A resend is harmless anyway: the event
 * id, the record function's idempotency and drovr's first-wins all keep one
 * fact.
 */
export async function runInterestBackfill(
	deps: BackfillDeps,
): Promise<BackfillReport> {
	if (deps.mode === 'send' && !deps.resolveDrovr && !deps.includeUnresolved)
		throw new BackfillRefused(
			'send needs drovr resolution configured to choose resolvable holders',
		)
	const pacer = createPacer(deps.ratePerSecond, deps.clock)
	const chunkSize = deps.chunkSize ?? 500
	const concurrency = deps.concurrency ?? 8
	const resumedFromLine = deps.mode === 'send' ? await deps.readCursor() : 0
	const perKey: Record<string, BackfillKeyCounts> = Object.fromEntries(
		deps.keys.map((key) => [key, emptyCounts()]),
	)
	let lines = 0
	let malformedLines = 0
	let lastLine = resumedFromLine
	let stopped = false
	let chunk: BackfillHolder[] = []

	const flush = async (throughLine: number): Promise<boolean> => {
		const holders = chunk
		chunk = []
		const emails = Array.from(new Set(holders.map((h) => h.email)))
		const localIds = await mapLimit(emails, concurrency, (email) =>
			deps.findContactIdForEmail(email),
		)
		const local = new Map(emails.map((email, i) => [email, localIds[i]]))
		const drovr = deps.resolveDrovr
			? await deps.resolveDrovr(emails)
			: undefined
		const events: { line: number; event: BackfillEvent; key: string }[] = []
		for (const holder of holders) {
			const counts = perKey[holder.fieldKey]!
			counts.holders += 1
			counts.byState[holder.state] = (counts.byState[holder.state] ?? 0) + 1
			const localFound = Boolean(local.get(holder.email))
			counts.local[localFound ? 'resolved' : 'unresolved'] += 1
			const drovrStatus: Resolution = drovr
				? (drovr.get(holder.email.trim().toLowerCase())?.status ?? 'missing')
				: 'not-checked'
			counts.drovr[drovrStatus] += 1
			const resolvable = localFound && drovrStatus === 'resolved'
			if (resolvable) counts.resolvable += 1
			counts.date[
				holder.dateSource === 'created_at' ? 'createdAt' : holder.dateSource
			] += 1
			if (deps.mode !== 'send') continue
			if (!holder.expressedAt) {
				counts.skippedNoDate += 1
			} else if (!resolvable && !deps.includeUnresolved) {
				counts.skippedUnresolved += 1
			} else {
				events.push({
					line: holder.line,
					key: holder.fieldKey,
					event: backfillEvent({ ...holder, expressedAt: holder.expressedAt }),
				})
			}
		}
		for (let start = 0; start < events.length; start += pacer.batchSize) {
			if (await deps.stopRequested()) return false
			const batch = events.slice(start, start + pacer.batchSize)
			await pacer.before(batch.length)
			await deps.send(batch.map((item) => item.event))
			for (const item of batch) perKey[item.key]!.sent += 1
			const next = events[start + pacer.batchSize]
			// A line is done only when none of its events is still to send.
			lastLine = next ? next.line - 1 : throughLine
			await deps.writeCursor(lastLine)
		}
		if (deps.mode === 'send' && lastLine !== throughLine) {
			lastLine = throughLine
			await deps.writeCursor(lastLine)
		}
		lastLine = throughLine
		return true
	}

	let lineNumber = 0
	for await (const text of deps.lines) {
		lineNumber += 1
		if (lineNumber <= resumedFromLine) continue
		if (!text.trim()) continue
		lines += 1
		const found = holdersOnLine({
			line: lineNumber,
			text,
			keys: deps.keys,
			nowMs: deps.clock.now(),
		})
		if (found === 'malformed') {
			malformedLines += 1
			continue
		}
		chunk.push(...found)
		if (chunk.length >= chunkSize) {
			if (deps.mode === 'send' && (await deps.stopRequested())) {
				chunk = []
				stopped = true
				break
			}
			if (!(await flush(lineNumber))) {
				stopped = true
				break
			}
		}
	}
	if (!stopped && (chunk.length > 0 || lineNumber > lastLine)) {
		if (!(await flush(Math.max(lineNumber, lastLine)))) stopped = true
	}
	return {
		mode: deps.mode,
		keys: [...deps.keys],
		lines,
		malformedLines,
		resumedFromLine,
		lastLine,
		stopped,
		perKey,
		expressedAt: EXPRESSED_AT_RULE,
	}
}
