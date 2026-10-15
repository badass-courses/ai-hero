import { NonRetriableError, RetryAfterError } from 'inngest'
import { DROVR_SEND_RETRIES, drovrRetryDelayMs } from './drovr-outbox'
import { BULK_EVENT_INTERVAL_MS, BULK_CLASS_SLOTS } from './contact-sync-deltas'

export type BulkClass = keyof typeof BULK_CLASS_SLOTS
export type BulkCursors = Partial<Record<BulkClass, number>>
// One globally disjoint 600ms grid: 60 delta, 20 restate, 15 ingest,
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
		Math.max(cursors[kind] ?? 0, now) / BULK_EVENT_INTERVAL_MS,
	)
	while (CLASSES[index % CLASSES.length] !== kind) index++
	const slot = index * BULK_EVENT_INTERVAL_MS
	if (slot - now > BULK_SLOT_LOOKAHEAD_MS)
		throw new RetryAfterError(
			'BulkLookahead: you reserved a paced send, and it failed because the class is more than ten minutes ahead. Accepted: a bounded reservation. Fix: let this class drain before retrying unchanged. Debug: inspect the paced lane backlog.',
			'1m',
		)
	return {
		slot,
		cursors: { ...cursors, [kind]: slot + BULK_EVENT_INTERVAL_MS },
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
/** A single row lock serializes future-slot allocation. UTC is set and checked
 * on the owned connection, never assumed from the client date-parser setting.
 * Seed only a missing row, once per warm process; no INSERT on every send.
 */
export async function reserveBulkSlot(
	acquire: () => Promise<PaceConnection>,
	table: string,
	kind: BulkClass,
): Promise<number> {
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
		await connection.query("SET time_zone = '+00:00'")
		await connection.beginTransaction()
		const [row] = rowsOf(
			await connection.query(
				`SELECT \`cursor\`, CAST(UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3)) * 1000 AS UNSIGNED) AS now, @@session.time_zone AS timezone FROM ${quoted} WHERE \`name\` = ? FOR UPDATE`,
				[name],
			),
		)
		if (!row || row.timezone !== '+00:00')
			throw new Error(
				'BulkClock: you reserved a send, and it failed because the locked database clock is not UTC. Accepted: a seeded row and UTC session. Fix: restore the pace store. Debug: inspect the connection time zone.',
			)
		const { slot, cursors } = nextBulkSlot(
			JSON.parse(String(row.cursor)),
			kind,
			Number(row.now),
		)
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
): Promise<number> {
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
	const slot = (await step.run(`${id}:reserve`, () => reserve(kind))) as number
	await step.sleepUntil(`${id}:slot`, new Date(slot))
}

/** HTTP retries must reserve new slots; an Inngest retry of a POST step would
 * otherwise reuse an old memoized reservation. Return retry data from each
 * POST step and drive the bounded retry lifecycle with new durable step ids.
 */
export async function runPacedSend<T>(
	step: PaceStep,
	id: string,
	pace: (id: string, step: PaceStep) => Promise<void>,
	send: (attempt: number) => Promise<T>,
	firstAttempt = 0,
): Promise<T> {
	// Outer retries may be backpressure, not failed HTTP attempts. Preserve
	// this send's original start so they replay completed POST steps rather
	// than skipping to a fresh attempt namespace and sending them twice.
	const start = (await step.run(
		`${id}:initial-attempt`,
		async () => firstAttempt,
	)) as number
	for (let attempt = start; attempt <= DROVR_SEND_RETRIES; attempt++) {
		const key = `${id}:attempt:${attempt}`
		await pace(key, step)
		const answer = (await step.run(key, async () => {
			try {
				return { ok: true as const, value: await send(attempt) }
			} catch (error) {
				if (error instanceof NonRetriableError) throw error
				const seconds =
					error instanceof RetryAfterError ? Number(error.retryAfter) : NaN
				return {
					ok: false as const,
					message: error instanceof Error ? error.message : String(error),
					retryAt:
						Date.now() +
						(Number.isFinite(seconds)
							? seconds * 1000
							: drovrRetryDelayMs(attempt)),
				}
			}
		})) as
			| { ok: true; value: T }
			| { ok: false; message: string; retryAt: number }
		if (answer.ok) return answer.value
		if (attempt === DROVR_SEND_RETRIES)
			throw new NonRetriableError(
				`PacedDelivery: you exhausted durable POST attempts, and it failed because ${answer.message}. Accepted: a delivered event or captured final failure. Fix: restore the outbox and explicitly replay this run. Debug: inspect the final capture receipt.`,
			)
		await step.sleepUntil(`${key}:retry`, new Date(answer.retryAt))
	}
	throw new NonRetriableError(
		'PacedAttempts: you requested a send, and it failed because the attempt index is invalid. Accepted: a bounded send attempt. Fix: inspect the run context. Debug: compare the attempt with the retry budget.',
	)
}
