import { drovrOutbox } from '@/db/drovr-outbox-schema'
import { and, asc, count, eq, inArray, lte, min, or, sql } from 'drizzle-orm'

import {
	DrovrOutboxUnavailableError,
	DROVR_OUTBOX_STOP_EVENT_TYPES,
	type DrovrOutboxOpenGate,
	type DrovrOutboxRow,
	type DrovrOutboxStore,
} from './drovr-outbox'

type ErrorLike = {
	cause?: unknown
	code?: unknown
	errno?: unknown
	message?: unknown
	sqlMessage?: unknown
}

/** MySQL 1146 (ER_NO_SUCH_TABLE), anywhere in the cause chain. */
export function isMysqlMissingTableError(error: unknown): boolean {
	let current = error
	for (
		let depth = 0;
		depth < 5 && current && typeof current === 'object';
		depth++
	) {
		const candidate = current as ErrorLike
		if (candidate.errno === 1146 || candidate.code === 'ER_NO_SUCH_TABLE')
			return true
		const text = [candidate.message, candidate.sqlMessage]
			.filter((value): value is string => typeof value === 'string')
			.join(' ')
		if (/AI_DrovrOutbox'? doesn't exist/i.test(text)) return true
		current = candidate.cause
	}
	return false
}

async function guarded<T>(operation: () => Promise<T>): Promise<T> {
	try {
		return await operation()
	} catch (error) {
		if (isMysqlMissingTableError(error))
			throw new DrovrOutboxUnavailableError(error)
		throw error
	}
}

/** MySQL timestamp(3) columns take 'YYYY-MM-DD HH:MM:SS.mmm' in UTC. */
function toSqlTimestamp(iso: string): string {
	return new Date(iso).toISOString().slice(0, 23).replace('T', ' ')
}

const sqlTimestampOrNull = (iso: string | null | undefined) =>
	iso ? toSqlTimestamp(iso) : null

function isoOf(value: string | Date): string {
	if (value instanceof Date) return value.toISOString()
	// The driver hands back 'YYYY-MM-DD HH:MM:SS.mmm' in UTC.
	return /(Z|[+-]\d{2}:?\d{2})$/.test(value)
		? new Date(value).toISOString()
		: new Date(`${value.replace(' ', 'T')}Z`).toISOString()
}

const isoOrNull = (value: string | Date | null) =>
	value === null ? null : isoOf(value)

type StoredRow = typeof drovrOutbox.$inferSelect

function fromStored(row: StoredRow): DrovrOutboxRow {
	return {
		id: row.id,
		dedupeKey: row.dedupeKey,
		target: row.target,
		endpoint: row.endpoint as DrovrOutboxRow['endpoint'],
		tenantId: row.tenantId,
		contactId: row.contactId,
		journeyId: row.journeyId,
		eventType: row.eventType,
		idempotencyKey: row.idempotencyKey,
		body: (typeof row.body === 'string'
			? JSON.parse(row.body)
			: row.body) as DrovrOutboxRow['body'],
		needsFanOut: Boolean(row.needsFanOut),
		source: row.source as DrovrOutboxRow['source'],
		status: row.status as DrovrOutboxRow['status'],
		attempts: row.attempts,
		lastStatus: row.lastStatus ?? null,
		lastError: row.lastError ?? null,
		occurredAt: isoOf(row.occurredAt),
		firstFailedAt: isoOf(row.firstFailedAt),
		nextAttemptAt: isoOf(row.nextAttemptAt),
		lastAttemptAt: isoOrNull(row.lastAttemptAt),
		deliveredAt: isoOrNull(row.deliveredAt),
		releasedAt: isoOrNull(row.releasedAt),
		createdAt: isoOf(row.createdAt),
	}
}

/**
 * The AI_DrovrOutbox-backed store. Every call turns a missing table (1146)
 * into DrovrOutboxUnavailableError, so the code can deploy before the
 * deploy request is applied. The due read rides DrovrOutbox_due_idx, the
 * purge DrovrOutbox_delivered_idx.
 */
export function createDrizzleDrovrOutboxStore(
	// The same shape the capture repository takes; drizzle's MySqlDatabase
	// generics are unwieldy here.
	database: unknown,
): DrovrOutboxStore {
	const db = database as {
		select: (fields?: unknown) => any
		insert: (table: unknown) => any
		update: (table: unknown) => any
		delete: (table: unknown) => any
	}
	return {
		insertIgnore: (rows) =>
			guarded(async () => {
				if (rows.length === 0) return
				// Only a duplicate dedupeKey is absorbed (the row stays as it
				// is); unlike INSERT IGNORE, a value that does not fit still
				// fails instead of being truncated.
				await db
					.insert(drovrOutbox)
					.values(
						rows.map((row) => ({
							...row,
							occurredAt: toSqlTimestamp(row.occurredAt),
							firstFailedAt: toSqlTimestamp(row.firstFailedAt),
							nextAttemptAt: toSqlTimestamp(row.nextAttemptAt),
							lastAttemptAt: sqlTimestampOrNull(row.lastAttemptAt),
							deliveredAt: sqlTimestampOrNull(row.deliveredAt),
							releasedAt: sqlTimestampOrNull(row.releasedAt),
							createdAt: toSqlTimestamp(row.createdAt),
						})),
					)
					.onDuplicateKeyUpdate({
						set: { dedupeKey: sql`${drovrOutbox.dedupeKey}` },
					})
			}),
		due: ({ target, now, limit }) =>
			guarded(async () => {
				const rows = (await db
					.select()
					.from(drovrOutbox)
					.where(
						and(
							eq(drovrOutbox.status, 'pending'),
							eq(drovrOutbox.target, target),
							lte(drovrOutbox.nextAttemptAt, toSqlTimestamp(now)),
						),
					)
					.orderBy(asc(drovrOutbox.nextAttemptAt), asc(drovrOutbox.id))
					.limit(limit)) as StoredRow[]
				return rows.map(fromStored)
			}),
		// Rides DrovrOutbox_contact_idx (target, contactId, status).
		openGates: ({ target, contactIds }) =>
			guarded(async () => {
				if (contactIds.length === 0) return []
				const rows = (await db
					.select({
						contactId: drovrOutbox.contactId,
						journeyId: drovrOutbox.journeyId,
						endpoint: drovrOutbox.endpoint,
						eventType: drovrOutbox.eventType,
						status: drovrOutbox.status,
						nextAttemptAt: drovrOutbox.nextAttemptAt,
						occurredAt: drovrOutbox.occurredAt,
					})
					.from(drovrOutbox)
					.where(
						and(
							eq(drovrOutbox.target, target),
							inArray(drovrOutbox.contactId, [...contactIds]),
							or(
								// A birth still owed.
								and(
									inArray(drovrOutbox.status, ['pending', 'held']),
									or(
										eq(drovrOutbox.eventType, 'contact.created'),
										eq(drovrOutbox.endpoint, 'signups'),
									),
								),
								// A stop still owed; a refused one fails closed.
								and(
									inArray(drovrOutbox.status, ['pending', 'held', 'rejected']),
									inArray(drovrOutbox.eventType, [
										...DROVR_OUTBOX_STOP_EVENT_TYPES,
									]),
								),
							),
						),
					)) as {
					contactId: string
					journeyId: string
					endpoint: string
					eventType: string
					status: string
					nextAttemptAt: string | Date
					occurredAt: string | Date
				}[]
				return rows.map(
					(row): DrovrOutboxOpenGate => ({
						contactId: row.contactId,
						journeyId: row.journeyId,
						endpoint: row.endpoint as DrovrOutboxOpenGate['endpoint'],
						eventType: row.eventType,
						status: row.status as DrovrOutboxOpenGate['status'],
						nextAttemptAt: isoOf(row.nextAttemptAt),
						occurredAt: isoOf(row.occurredAt),
					}),
				)
			}),
		update: (id, patch) =>
			guarded(async () => {
				await db
					.update(drovrOutbox)
					.set({
						...patch,
						...(patch.nextAttemptAt
							? { nextAttemptAt: toSqlTimestamp(patch.nextAttemptAt) }
							: {}),
						...('lastAttemptAt' in patch
							? { lastAttemptAt: sqlTimestampOrNull(patch.lastAttemptAt) }
							: {}),
						...('deliveredAt' in patch
							? { deliveredAt: sqlTimestampOrNull(patch.deliveredAt) }
							: {}),
					})
					.where(eq(drovrOutbox.id, id))
			}),
		depth: (target) =>
			guarded(async () => {
				const rows = (await db
					.select({
						status: drovrOutbox.status,
						count: count(),
						oldest: min(drovrOutbox.firstFailedAt),
					})
					.from(drovrOutbox)
					.where(
						and(
							eq(drovrOutbox.target, target),
							inArray(drovrOutbox.status, ['pending', 'held', 'rejected']),
						),
					)
					.groupBy(drovrOutbox.status)) as {
					status: string
					count: number | string
					oldest: string | Date | null
				}[]
				const of = (status: string) => rows.find((row) => row.status === status)
				const pending = of('pending')
				const [stop] = (await db
					.select({ oldest: min(drovrOutbox.firstFailedAt) })
					.from(drovrOutbox)
					.where(
						and(
							eq(drovrOutbox.target, target),
							inArray(drovrOutbox.status, ['pending', 'held', 'rejected']),
							inArray(drovrOutbox.eventType, [
								...DROVR_OUTBOX_STOP_EVENT_TYPES,
							]),
						),
					)) as { oldest: string | Date | null }[]
				return {
					pending: Number(pending?.count ?? 0),
					oldestPendingFailedAt: pending?.oldest ? isoOf(pending.oldest) : null,
					held: Number(of('held')?.count ?? 0),
					rejected: Number(of('rejected')?.count ?? 0),
					oldestOpenStopFailedAt: stop?.oldest ? isoOf(stop.oldest) : null,
				}
			}),
		deleteDeliveredBefore: (before, limit) =>
			guarded(async () => {
				const result = await db
					.delete(drovrOutbox)
					.where(
						and(
							eq(drovrOutbox.status, 'delivered'),
							lte(drovrOutbox.deliveredAt, toSqlTimestamp(before)),
						),
					)
					.limit(limit)
				const affected = Array.isArray(result)
					? (result[0] as { affectedRows?: number } | undefined)?.affectedRows
					: ((result as { rowsAffected?: number; affectedRows?: number })
							?.rowsAffected ??
						(result as { affectedRows?: number })?.affectedRows)
				return Number(affected ?? 0)
			}),
	}
}
