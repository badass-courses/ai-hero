import { NonRetriableError, RetryAfterError } from 'inngest'
import { DROVR_SEND_RETRIES, drovrRetryDelayMs } from './drovr-outbox'
import { BULK_EVENTS_PER_MINUTE, BULK_CLASS_SLOTS } from './contact-sync-deltas'
import { BULK_SLOT_TOLERANCE_MS, BulkSlotExpiredError, BulkPaceYieldError, withBulkPostPermit } from './drovr-bulk-permit'
import { BULK_DB_UTC_EPOCH, bulkClockBounds, probeDrovrBulkClock, type BulkClockProbe } from './drovr-bulk-clock'
// Even a closed 60-second window excludes 101 starts:
// 100 * 604 - 300 = 60,100ms > 60,000ms. Freshness is checked at fetch.
export const BULK_RESERVATION_INTERVAL_MS = Math.ceil((60_000 + BULK_SLOT_TOLERANCE_MS + 1) / BULK_EVENTS_PER_MINUTE)
export const BULK_BOOKINGS_PER_ATTEMPT = 3

export type BulkClass = keyof typeof BULK_CLASS_SLOTS
export type BulkCursors = Partial<Record<BulkClass, number>>
// One globally disjoint guarded grid: up to 60 delta, 20 restate, 15 ingest,
// 5 backfill slots/minute. Background cannot reserve delta capacity.
const CLASSES: BulkClass[] = Object.entries(BULK_CLASS_SLOTS).flatMap(
	([kind, slots]) => Array<BulkClass>(slots).fill(kind as BulkClass),
)
export const BULK_SLOT_LOOKAHEAD_MS = 10 * 60_000
export function nextBulkSlot(
	cursors: BulkCursors,
	kind: BulkClass,
	now: number,
) {
	if (
		!CLASSES.includes(kind) ||
		!Number.isSafeInteger(now) ||
		now < 0 ||
		Object.values(cursors).some(
			(value) => !Number.isSafeInteger(value) || value! < 0,
		)
	)
		throw new Error(
			'BulkCursor: you reserved a send, and it failed because the stored clock or cursor is invalid. Accepted: nonnegative integer milliseconds. Fix: inspect the pace row before retrying. Debug: validate the cursor values.',
		)
	let index = Math.ceil(
		Math.max(cursors[kind] ?? 0, now) / BULK_RESERVATION_INTERVAL_MS,
	)
	while (CLASSES[index % CLASSES.length] !== kind) index++
	const slot = index * BULK_RESERVATION_INTERVAL_MS
	if (slot - now > BULK_SLOT_LOOKAHEAD_MS) return { slot, cursors, retryAt: now + 60_000 }
	return {
		slot,
		cursors: { ...cursors, [kind]: slot + BULK_RESERVATION_INTERVAL_MS },
	}
}
export type PaceConnection = {
	query(sql: string, values?: unknown[]): Promise<unknown>
	beginTransaction(): Promise<unknown>
	commit(): Promise<unknown>
	rollback(): Promise<unknown>
	release(): void
}
const seeded = new WeakMap<() => Promise<PaceConnection>, Promise<void>>()
const rowsOf = (result: unknown) =>
	(Array.isArray(result)
		? result[0]
		: (result as { rows: unknown[] }).rows) as Record<string, unknown>[]
/** A single row lock serializes future-slot allocation. Read the DB UTC epoch
 * without session SET; the app wall clock never participates in allocation.
 * Seed only a missing row, once per warm process; no INSERT on every send.
 */
export async function reserveBulkSlot(
	acquire: () => Promise<PaceConnection>,
	table: string,
	kind: BulkClass,
): Promise<number | { retryAt: number }> {
	const name = 'bulk-delivery-pace-v2'
	const quoted = '`' + table.replaceAll('`', '``') + '`'
	if (!seeded.has(acquire)) {
		const seed = (async () => {
			const connection = await acquire()
			try {
				if (
					!rowsOf(
						await connection.query(
							`SELECT \`name\` FROM ${quoted} WHERE \`name\` = ?`,
							[name],
						),
					).length
				)
					await connection.query(
						`INSERT IGNORE INTO ${quoted} (\`name\`, \`cursor\`) VALUES (?, '{}')`,
						[name],
					)
			} finally {
				connection.release()
			}
		})()
		seeded.set(acquire, seed)
		seed.catch(() => seeded.delete(acquire))
	}
	await seeded.get(acquire)
	const connection = await acquire()
	try {
		await connection.beginTransaction()
		const [row] = rowsOf(
			await connection.query(
				`SELECT \`cursor\`, ${BULK_DB_UTC_EPOCH} AS now FROM ${quoted} WHERE \`name\` = ? FOR UPDATE`,
				[name],
			),
		)
		if (!row || row.now == null || !Number.isSafeInteger(Number(row.now)) || Number(row.now) < 0)
			throw new Error(
				'BulkClock: you reserved a send, and it failed because the seeded row or database UTC epoch is invalid. Accepted: a nonnegative whole UTC epoch. Fix: restore the database clock and pace row. Debug: inspect UTC_TIMESTAMP; do not mutate the pooled session.',
			)
		const { slot, cursors, retryAt } = nextBulkSlot(
			JSON.parse(String(row.cursor)),
			kind,
			Number(row.now),
		)
		if (retryAt !== undefined) { await connection.commit(); return { retryAt } }
		await connection.query(
			`UPDATE ${quoted} SET \`cursor\` = ? WHERE \`name\` = ?`,
			[JSON.stringify(cursors), name],
		)
		await connection.commit()
		return slot
	} catch (error) {
		await connection.rollback()
		throw error
	} finally {
		connection.release()
	}
}
export async function reserveDrovrBulkSlot(
	kind: BulkClass = 'delta',
): Promise<number | { retryAt: number }> {
	const [
		{ acquireDatabaseConnection },
		{ contactSyncCursor },
		{ getTableName },
	] = await Promise.all([
		import('@/db'),
		import('@/db/contact-sync-schema'),
		import('drizzle-orm'),
	])
	return reserveBulkSlot(
		acquireDatabaseConnection as unknown as () => Promise<PaceConnection>,
		getTableName(contactSyncCursor),
		kind,
	)
}
export type PaceStep = {
	run<T>(id: string, callback: () => Promise<T>): Promise<unknown>
	sleepUntil(id: string, date: Date): Promise<unknown>
}
/** Outside the send/outbox wrapper: backpressure must not consume send retries
 * or capture a healthy event as a failed POST. Sleep is durable, not a timer.
 */
export async function waitForBulkSlot(
	step: PaceStep,
	id: string,
	kind: BulkClass = 'delta',
	reserve = reserveDrovrBulkSlot,
) {
	for (let booking = 0; booking < BULK_BOOKINGS_PER_ATTEMPT; booking++) {
		const key = `${id}:booking:${booking}`
		const slot = (await step.run(`${key}:reserve`, () => reserve(kind))) as number | { retryAt: number }
		if (typeof slot !== 'number') { await step.sleepUntil(`${key}:capacity`, new Date(slot.retryAt)); continue }
		await step.sleepUntil(`${key}:slot`, new Date(slot))
		return slot
	}
	throw new BulkPaceYieldError()
}

/** HTTP retries must reserve new slots; an Inngest retry of a POST step would
 * otherwise reuse an old memoized reservation. Return retry data from each
 * POST step and drive the bounded retry lifecycle with new durable step ids.
 */
export async function runPacedSend<T>(
	step: PaceStep,
	id: string,
	pace: (id: string, step: PaceStep) => Promise<number>,
	send: (attempt: number) => Promise<T>,
	_legacyAttempt = 0,
	clockProbe: BulkClockProbe = probeDrovrBulkClock,
): Promise<T> {
	// Outer retries may be backpressure, not failed HTTP attempts. Preserve
	// this send's original start so they replay completed POST steps rather
	// than skipping to a fresh attempt namespace and sending them twice.
	const start = (await step.run(
		`${id}:initial-attempt`,
		async () => 0,
	)) as number
	for (let attempt = start; attempt <= DROVR_SEND_RETRIES; attempt++) {
		let failed: { message: string; retryAt: number } | undefined
		for (let booking = 0; booking < BULK_BOOKINGS_PER_ATTEMPT; booking++) {
			const key = `${id}:attempt:${attempt}:booking:${booking}`
			const slot = await pace(key, step)
			const answer = (await step.run(key, async () => {
				// Executes in the real POST callback, not discovery/replay. One
				// DB sample projects through all later async work to actual fetch.
				const clock = await clockProbe()
				try { return { ok: true as const, value: await withBulkPostPermit(slot, () => send(attempt), clock) } }
				catch (error) {
					if (error instanceof BulkSlotExpiredError) return { expired: true as const }
					if (error instanceof NonRetriableError) throw error
					const hint: unknown = error instanceof RetryAfterError ? error.retryAfter : undefined
					const numeric = typeof hint === 'number' || typeof hint === 'string' && /^\d+(\.\d+)?$/.test(hint) ? Number(hint) : NaN
					const date = hint instanceof Date ? hint.getTime() : typeof hint === 'string' ? Date.parse(hint) : NaN
					const utcNow = bulkClockBounds(clock)?.upper ?? clock.utcMs
					return { ok: false as const, message: error instanceof Error ? error.message : String(error), retryAt: Number.isFinite(numeric) ? utcNow + numeric * 1000 : Number.isFinite(date) ? Math.max(utcNow, date) : utcNow + drovrRetryDelayMs(attempt) }
				}
			})) as { expired: true } | { ok: true; value: T } | { ok: false; message: string; retryAt: number }
			if ('expired' in answer) continue
			if (answer.ok) return answer.value
			failed = answer
			if (attempt < DROVR_SEND_RETRIES) await step.sleepUntil(`${key}:retry`, new Date(answer.retryAt))
			break
		}
		if (!failed) throw new BulkPaceYieldError()
		if (attempt === DROVR_SEND_RETRIES) throw new NonRetriableError(`PacedDelivery: you exhausted durable POST attempts, and it failed because ${failed.message}. Accepted: a delivered event or captured final failure. Fix: restore the outbox and explicitly replay this run. Debug: inspect the final capture receipt.`)
	}
	throw new NonRetriableError(
		'PacedAttempts: you requested a send, and it failed because the attempt index is invalid. Accepted: a bounded send attempt. Fix: inspect the run context. Debug: compare the attempt with the retry budget.',
	)
}
