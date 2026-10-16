import { drovrOutbox } from '@/db/drovr-outbox-schema'
import { expireAckTombstones } from './contact-sync-ack-tombstone-expiry'
import {
	and,
	asc,
	count,
	eq,
	gt,
	inArray,
	lte,
	min,
	notInArray,
	or,
	sql,
	type SQL,
} from 'drizzle-orm'

import {
	DrovrOutboxUnavailableError,
	DROVR_OUTBOX_EVERGREEN_START,
	DROVR_OUTBOX_DELIVERED_RETENTION_MS,
	DROVR_OUTBOX_PURGE_BATCH,
	DROVR_OUTBOX_STOP_EVENT_TYPES,
	type DrovrOutboxOpenGate,
	type DrovrOutboxRow,
	type DrovrOutboxStore,
} from './drovr-outbox'

import { readOutboxQueueState } from './drovr-outbox-queue-state'
import { assertOutboxWireRow, DROVR_OUTBOX_WIRE_STATUSES } from './drovr-outbox-wire-status'
import { decideOwnerStopRejection } from './drovr-owner-stop-rejection'
import { readWithHeldContinuationFallback, writeHeldContinuationGuard, OUTBOX_CONTROL_MAX_ENCODED_BYTES } from './drovr-outbox-control'
import { getTableColumns } from 'drizzle-orm'
export const { heldContinuation: heldContinuationColumn, ...legacyOutboxColumns } = getTableColumns(drovrOutbox)
import { collectHeldBatchPins, HELD_BATCH_PIN_SCAN_MAX_COORDINATORS, unpinnedDeliveredCandidates } from './contact-sync-held-batch-pins'
import { HeldBatchContinuationError } from './contact-sync-held-batch'
import { retryHeldBatchTransaction } from './contact-sync-held-batch-transaction'
import { protectProfileAckPurge, type ProfileAckPurgeCandidate } from './contact-sync-profile-ack-purge'
import { settleProfileAckWorkerRows, type ProfileAckWorkerKey } from './contact-sync-profile-ack-worker'
import { logAckEvidenceExpiredOncePerProcess } from './contact-sync-profile-ack-expired-log'

// JSON parents are explicit: JSON_SET does not create missing parent objects.
export const queueEnvelope = sql`JSON_SET(IF(${drovrOutbox.heldContinuation} IS NULL OR JSON_TYPE(${drovrOutbox.heldContinuation}) = 'NULL', JSON_OBJECT('v', 1), ${drovrOutbox.heldContinuation}), '$.replayProof', COALESCE(JSON_EXTRACT(${drovrOutbox.heldContinuation}, '$.replayProof'), JSON_OBJECT('v', 1, 'handoffs', 0)))`
export const withQueueDiagnostic = (note: string | null) => sql`${note}`
const publicationSql = sql`JSON_UNQUOTE(JSON_EXTRACT(${drovrOutbox.heldContinuation}, '$.replayProof.publicationId'))`

// Drizzle emits SET fields in schema order, NOT the input object's order.
// Match the old encoded permission instead of reading status after SET status.
// A concurrent newer operator release therefore keeps its permission intact.
export const withSupersededDiagnostic = (note: string, _heldContinuation?: unknown) => withQueueDiagnostic(note)
export const withSupersededControl = (encoded: string, reason: string) => sql`IF(JSON_UNQUOTE(JSON_EXTRACT(${drovrOutbox.heldContinuation}, '$.continuation.encoded')) = BINARY ${encoded}, JSON_SET(${drovrOutbox.heldContinuation}, '$.continuation.blocked', JSON_EXTRACT('true', '$'), '$.continuation.reason', ${reason}), ${drovrOutbox.heldContinuation})`

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

export function fromStored(row: Omit<StoredRow, 'heldContinuation'> & { heldContinuation?: unknown }): DrovrOutboxRow {
	assertOutboxWireRow(row)
	const body = typeof row.body === 'string' ? JSON.parse(row.body) : row.body
	assertOutboxWireRow({ status: row.status, source: row.source, endpoint: row.endpoint, eventType: row.eventType, body })
	const queue = readOutboxQueueState(row.heldContinuation, row.lastError ?? null)
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
		body: body as DrovrOutboxRow['body'],
		needsFanOut: Boolean(row.needsFanOut),
		source: row.source as DrovrOutboxRow['source'],
		status: row.status as DrovrOutboxRow['status'],
		attempts: row.attempts,
		lastStatus: row.lastStatus ?? null,
		lastError: queue.diagnostic,
		...(row.heldContinuation == null ? {} : { heldContinuation: row.heldContinuation }),
		queueHandoffs: queue.handoffs,
		...(queue.waitingForStop ? { waitingForStop: true } : {}),
		queueMetadataInvalid: queue.invalid,
		...('heldBatch' in queue ? { heldBatch: queue.heldBatch } : {}),
		...(queue.heldBatchBlocked !== undefined ? { heldBatchBlocked: queue.heldBatchBlocked } : {}),
		...(queue.heldBatchReason !== undefined ? { heldBatchReason: queue.heldBatchReason } : {}),
		...(queue.publicationId ? { queuePublicationId: queue.publicationId } : {}),
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
/** Rows a write touched, from either driver's result shape. */
export const affectedRows = (result: unknown): number => {
	const affected = Array.isArray(result)
		? (result[0] as { affectedRows?: number } | undefined)?.affectedRows
		: ((result as { rowsAffected?: number; affectedRows?: number })
				?.rowsAffected ?? (result as { affectedRows?: number })?.affectedRows)
	return Number(affected ?? 0)
}

export function createDrizzleDrovrOutboxStore(
	// The same shape the capture repository takes; drizzle's MySqlDatabase
	// generics are unwieldy here.
	database: unknown,
	options: { profileAckEnabled?: () => Promise<boolean>; onProfileAckSettlement?: (result: import('./contact-sync-profile-ack-persistence').ProfileAckSettlement) => void } = {},
): DrovrOutboxStore {
	type Operations = {
		select: (fields?: unknown) => any
		insert: (table: unknown) => any
		update: (table: unknown) => any
		delete: (table: unknown) => any
	}
	const db = database as Operations & { transaction: <A>(run: (tx: Operations) => Promise<A>) => Promise<A> }
	const profileAckEnabled = options.profileAckEnabled ?? (async () => {
		const { profileAckEnabled } = await import('./contact-sync-profile-ack-flag-live')
		return profileAckEnabled()
	})
	const scopeKeys = (keys?: readonly ProfileAckWorkerKey[]) => keys
		? or(...keys.map(row => and(eq(drovrOutbox.target, row.target), eq(drovrOutbox.dedupeKey, row.dedupeKey))))
		: undefined
	const settleAccepted = async (where: SQL | undefined, settle: (tx: Operations, keys?: readonly ProfileAckWorkerKey[], coordinated?: boolean) => Promise<number>, receiverAccepted: boolean) => {
		// No control-column/flag dependency for genuine delivery. This first
		// projection only identifies eligible native families, never proof.
		const rows = await db.select({ target: drovrOutbox.target, dedupeKey: drovrOutbox.dedupeKey, endpoint: drovrOutbox.endpoint, tenantId: drovrOutbox.tenantId, contactId: drovrOutbox.contactId, journeyId: drovrOutbox.journeyId, eventType: drovrOutbox.eventType }).from(drovrOutbox).where(where)
		const result = await settleProfileAckWorkerRows({ database, rows, enabled: profileAckEnabled, receiverAccepted, settle: (tx, keys, coordinated) => settle(tx as Operations, keys, coordinated) })
		for (const ack of result.acknowledgements) options.onProfileAckSettlement?.(ack)
		for (const ack of result.acknowledgements) if (ack._tag === 'ProfileAckSettled' && ack.evaluation._tag === 'AckEvidenceExpired') {
			try {
				const { log } = await import('@/server/logger')
				await logAckEvidenceExpiredOncePerProcess(ack.evaluation, log)
			} catch { /* Logging cannot turn terminal expiry into an SDK retry. */ }
		}
		return result.settled
	}
	return {
		deleteExpiredAckTombstones: target => expireAckTombstones({ database, target, enabled: profileAckEnabled }),
		insertIgnore: (rows) =>
			guarded(async () => {
				if (rows.length === 0) return
				for (const row of rows) assertOutboxWireRow(row)
				// Only a duplicate dedupeKey is absorbed (the row stays as it
				// is); unlike INSERT IGNORE, a value that does not fit still
				// fails instead of being truncated.
				await db
					.insert(drovrOutbox)
					.values(
						rows.map(({ queueHandoffs: _queue, queueMetadataInvalid: _invalid, queuePublicationId: _publication, ...row }) => ({
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
				const read = (fields?: typeof legacyOutboxColumns) => db
					.select(fields)
					.from(drovrOutbox)
					.where(
						and(
							inArray(drovrOutbox.status, ['pending', 'deferred']),
							eq(drovrOutbox.target, target),
							lte(drovrOutbox.nextAttemptAt, toSqlTimestamp(now)),
						),
					)
					.orderBy(asc(drovrOutbox.nextAttemptAt), asc(drovrOutbox.id))
					.limit(limit)
				const rows = await readWithHeldContinuationFallback<Parameters<typeof fromStored>[0][]>(() => read(), () => read(legacyOutboxColumns))
				return rows.map(fromStored)
			}),
		// Rides DrovrOutbox_contact_idx (target, contactId, status).
		openGates: ({ target, contactIds }) =>
			guarded(async () => {
				if (contactIds.length === 0) return []
				const read = (held: boolean) => db
					.select({
						...(held ? { heldContinuation: drovrOutbox.heldContinuation } : {}),
						target: drovrOutbox.target,
						dedupeKey: drovrOutbox.dedupeKey,
						tenantId: drovrOutbox.tenantId,
						idempotencyKey: drovrOutbox.idempotencyKey,
						body: drovrOutbox.body,
						lastStatus: drovrOutbox.lastStatus,
						lastAttemptAt: drovrOutbox.lastAttemptAt,
						id: drovrOutbox.id,
						contactId: drovrOutbox.contactId,
						journeyId: drovrOutbox.journeyId,
						endpoint: drovrOutbox.endpoint,
						eventType: drovrOutbox.eventType,
						status: drovrOutbox.status,
						nextAttemptAt: drovrOutbox.nextAttemptAt,
						occurredAt: drovrOutbox.occurredAt,
						lastError: drovrOutbox.lastError,
					})
					.from(drovrOutbox)
					.where(
						and(
							eq(drovrOutbox.target, target),
							inArray(drovrOutbox.contactId, [...contactIds]),
							or(
								// A birth still owed.
								and(
									inArray(drovrOutbox.status, ['pending', 'deferred', 'held']),
									or(
										eq(drovrOutbox.eventType, 'contact.created'),
										eq(drovrOutbox.endpoint, 'signups'),
										and(
											eq(
												drovrOutbox.eventType,
												DROVR_OUTBOX_EVERGREEN_START.eventType,
											),
											eq(
												drovrOutbox.journeyId,
												DROVR_OUTBOX_EVERGREEN_START.journeyId,
											),
										),
									),
								),
								// A stop still owed; a refused one fails closed.
								and(
									inArray(drovrOutbox.status, ['pending', 'deferred', 'held', 'rejected', 'superseded']),
									inArray(drovrOutbox.eventType, [
										...DROVR_OUTBOX_STOP_EVENT_TYPES,
									]),
								),
							),
						),
					)
				const rows = await readWithHeldContinuationFallback(() => read(true), async () => (await read(false)).map((row: Record<string, unknown>) => ({ ...row, heldContinuation: undefined, heldContinuationAvailable: false }))) as {
					heldContinuation?: unknown
					heldContinuationAvailable?: boolean
					target: string
					dedupeKey: string
					tenantId: string
					idempotencyKey: string
					body: unknown
					lastStatus: number | null
					lastAttemptAt: string | Date | null
					id: string
					contactId: string
					journeyId: string
					endpoint: string
					eventType: string
					status: string
					nextAttemptAt: string | Date
					occurredAt: string | Date
					lastError: string | null
				}[]
				const { closeSupersededUnsubscribeRows } = await import('./drovr-unsubscribe-supersession')
				const closed = await closeSupersededUnsubscribeRows(database, target, rows)
				return closed.flatMap((row): DrovrOutboxOpenGate[] => {
					const rejection = decideOwnerStopRejection({ ...row, occurredAt: isoOf(row.occurredAt), lastAttemptAt: row.lastAttemptAt ? isoOf(row.lastAttemptAt) : null })
					if (rejection.exclude) return []
					return [{
						...(row.status === 'rejected' && row.idempotencyKey?.startsWith('owner:') ? { ownerStopRejectionError: rejection.message } : {}),
						id: row.id,
						contactId: row.contactId,
						journeyId: row.journeyId,
						endpoint: row.endpoint as DrovrOutboxOpenGate['endpoint'],
						eventType: row.eventType,
						status: row.status as DrovrOutboxOpenGate['status'],
						nextAttemptAt: isoOf(row.nextAttemptAt),
						occurredAt: isoOf(row.occurredAt),
						...(row.supersededAt ? { supersededAt: row.supersededAt } : {}),
						...(row.unsubscribeSupersessionError ? { unsubscribeSupersessionError: row.unsubscribeSupersessionError } : {}),
					}]
				})
			}),
		leaseQueue: (args) => guarded(() => writeHeldContinuationGuard(async () => {
			const condition = 'dueAt' in args
				? lte(drovrOutbox.nextAttemptAt, toSqlTimestamp(args.dueAt))
				: eq(drovrOutbox.nextAttemptAt, toSqlTimestamp(args.expectedUntil))
			const proof = 'dueAt' in args ? sql`${publicationSql} IS NULL` : sql`${publicationSql} = ${args.publicationId}`
			const note = 'dueAt' in args ? sql`JSON_SET(JSON_REMOVE(${queueEnvelope}, '$.replayProof.waitingForStop'), '$.replayProof.publicationId', ${args.publicationId})` : sql`JSON_REMOVE(${queueEnvelope}, '$.replayProof.publicationId')`
			const result = await db.update(drovrOutbox).set({ nextAttemptAt: toSqlTimestamp(args.nextAttemptAt), heldContinuation: note }).where(and(eq(drovrOutbox.id, args.id), eq(drovrOutbox.target, args.target), inArray(drovrOutbox.status, ['pending', 'deferred']), condition, proof, sql`OCTET_LENGTH(${note}) <= ${OUTBOX_CONTROL_MAX_ENCODED_BYTES}`))
			return affectedRows(result) > 0
		})),
		recordQueueHandoff: ({ target, id, publicationId, count: charge }) => guarded(() => writeHeldContinuationGuard(async () => {
			// No post-publication lease/error write can erase a fast consumer.
			const document = sql`JSON_SET(JSON_REMOVE(${queueEnvelope}, '$.replayProof.publicationId'), '$.replayProof.handoffs', CAST(JSON_UNQUOTE(JSON_EXTRACT(${queueEnvelope}, '$.replayProof.handoffs')) AS UNSIGNED) + IF(${drovrOutbox.status} = 'pending' AND ${charge}, 1, 0))`
			await db.update(drovrOutbox).set({ heldContinuation: document }).where(and(eq(drovrOutbox.target, target), eq(drovrOutbox.id, id), inArray(drovrOutbox.status, ['pending', 'deferred']), sql`${publicationSql} = ${publicationId}`, sql`OCTET_LENGTH(${document}) <= ${OUTBOX_CONTROL_MAX_ENCODED_BYTES}`))
		})),
		abortQueueHandoff: ({ target, id, publicationId }) => guarded(() => writeHeldContinuationGuard(async () => {
			await db.update(drovrOutbox).set({ heldContinuation: sql`JSON_REMOVE(${queueEnvelope}, '$.replayProof.publicationId')` }).where(and(eq(drovrOutbox.target, target), eq(drovrOutbox.id, id), inArray(drovrOutbox.status, ['pending', 'deferred']), sql`${publicationSql} = ${publicationId}`))
		})),
		update: (id, patch) =>
			guarded(async () => {
				const { waitingForStop, ...columns } = patch
				let control = waitingForStop === undefined ? undefined : waitingForStop ? sql`JSON_SET(${queueEnvelope}, '$.replayProof.waitingForStop', JSON_EXTRACT('true', '$'))` : sql`JSON_REMOVE(${drovrOutbox.heldContinuation}, '$.replayProof.waitingForStop')`
				if (patch.status === 'rejected') control = sql`JSON_REMOVE(${control ?? drovrOutbox.heldContinuation}, '$.ownerStopRejection')`
				const where = and(eq(drovrOutbox.id, id), inArray(drovrOutbox.status, ['pending', 'deferred', 'held', 'rejected']))
				const write = (tx: Operations = db, keys?: readonly ProfileAckWorkerKey[], coordinated = false) => tx
					.update(drovrOutbox)
					.set({
						...columns,
						...(control ? { heldContinuation: control } : {}),
						...(patch.lastError === undefined ? {} : { lastError: withQueueDiagnostic(patch.lastError) }),
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
					.where(and(where, scopeKeys(keys), coordinated ? inArray(drovrOutbox.status, ['pending', 'deferred']) : undefined))
				const settle = async (tx: Operations, keys?: readonly ProfileAckWorkerKey[], coordinated?: boolean) => affectedRows(await write(tx, keys, coordinated))
				if (patch.status === 'delivered') await settleAccepted(where, settle, true)
				else await (control ? writeHeldContinuationGuard(() => write()) : write())
			}),
		supersedePending: ({ target, key, contactId, at }) => guarded(async () => {
			const { persistUnsubscribeSupersession } = await import('./drovr-unsubscribe-supersession-persistence')
			await persistUnsubscribeSupersession(database, { target, key, contactId, resubscribedAt: at })
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
							inArray(drovrOutbox.status, ['pending', 'deferred', 'held', 'rejected']),
						),
					)
					.groupBy(drovrOutbox.status)) as {
					status: string
					count: number | string
					oldest: string | Date | null
				}[]
				const of = (status: string) => rows.find((row) => row.status === status)
				const pending = of('pending')
				// The owed stops by status and source. A held stop was a decision
				// (a human's, or a 4xx drovr gave, row 204c): it has its own count
				// and age, for the held-stop monitor, and never pages as `stop`.
				// A stop the contact-sync straggler retry owns waits a day by
				// design, so it has its own age too.
				const stops = (await db
					.select({
						status: drovrOutbox.status,
						source: drovrOutbox.source,
						count: count(),
						oldest: min(drovrOutbox.firstFailedAt),
					})
					.from(drovrOutbox)
					.where(
						and(
							eq(drovrOutbox.target, target),
							inArray(drovrOutbox.status, ['pending', 'deferred', 'held', 'rejected']),
							inArray(drovrOutbox.eventType, [
								...DROVR_OUTBOX_STOP_EVENT_TYPES,
							]),
						),
					)
					.groupBy(drovrOutbox.status, drovrOutbox.source)) as {
					status: string
					source: string
					count: number | string
					oldest: string | Date | null
				}[]
				const oldestOf = (
					match: (row: { status: string; source: string }) => boolean,
				) => {
					const instants = stops
						.filter(match)
						.map((row) => (row.oldest ? isoOf(row.oldest) : null))
						.filter((at): at is string => at !== null)
						.sort()
					return instants[0] ?? null
				}
				return {
					pending: Number(pending?.count ?? 0),
					deferred: Number(of('deferred')?.count ?? 0),
					oldestPendingFailedAt: pending?.oldest ? isoOf(pending.oldest) : null,
					held: Number(of('held')?.count ?? 0),
					rejected: Number(of('rejected')?.count ?? 0),
					oldestOpenStopFailedAt: oldestOf(
						(row) =>
							(row.status === 'pending' || row.status === 'rejected'),
					),
					oldestDeferredStopFailedAt: oldestOf(
						(row) => row.status === 'deferred',
					),
					heldStops: stops
						.filter((row) => row.status === 'held')
						.reduce((sum, row) => sum + Number(row.count), 0),
					oldestHeldStopFailedAt: oldestOf((row) => row.status === 'held'),
				}
			}),
		// Rides DrovrOutbox_dedupe_uq.
		settlePending: ({ target, dedupeKeys, at, note, receiverAccepted = false }) =>
			guarded(async () => {
				if (dedupeKeys.length === 0) return 0
				const where = and(inArray(drovrOutbox.dedupeKey, [...dedupeKeys]), eq(drovrOutbox.target, target), inArray(drovrOutbox.status, [...DROVR_OUTBOX_WIRE_STATUSES]))
				return settleAccepted(where, async (tx, keys) => {
				const result = await tx
					.update(drovrOutbox)
					.set({
						status: 'delivered',
						deliveredAt: toSqlTimestamp(at),
						lastAttemptAt: toSqlTimestamp(at),
						lastError: withQueueDiagnostic(note),
					})
					.where(
						and(
							inArray(drovrOutbox.dedupeKey, [...dedupeKeys]),
							eq(drovrOutbox.target, target),
							scopeKeys(keys),
							inArray(drovrOutbox.status, ['pending', 'deferred']),
						),
					)
				return affectedRows(result)
				}, receiverAccepted)
			}),
		// Rides DrovrOutbox_dedupe_uq.
		holdPending: ({ target, dedupeKeys, at, note, httpStatus }) =>
			guarded(async () => {
				if (dedupeKeys.length === 0) return 0
				const result = await db
					.update(drovrOutbox)
					.set({
						status: 'held',
						lastAttemptAt: toSqlTimestamp(at),
						lastError: withQueueDiagnostic(note),
						lastStatus: httpStatus,
					})
					.where(
						and(
							inArray(drovrOutbox.dedupeKey, [...dedupeKeys]),
							eq(drovrOutbox.target, target),
							inArray(drovrOutbox.status, ['pending', 'deferred']),
						),
					)
				return affectedRows(result)
			}),
		// Rides DrovrOutbox_contact_idx (target, contactId, status).
		pullForward: ({ target, contactIds, now }) =>
			guarded(() => writeHeldContinuationGuard(async () => {
				if (contactIds.length === 0) return 0
				const result = await db
					.update(drovrOutbox)
					.set({ nextAttemptAt: toSqlTimestamp(now), heldContinuation: sql`JSON_REMOVE(${drovrOutbox.heldContinuation}, '$.replayProof.waitingForStop')` })
					.where(
						and(
							eq(drovrOutbox.target, target),
							inArray(drovrOutbox.contactId, [...contactIds]),
							inArray(drovrOutbox.status, ['pending', 'deferred']),
							gt(drovrOutbox.nextAttemptAt, toSqlTimestamp(now)),
							sql`JSON_EXTRACT(${drovrOutbox.heldContinuation}, '$.v') = 1 AND JSON_EXTRACT(${drovrOutbox.heldContinuation}, '$.replayProof.v') = 1 AND JSON_TYPE(JSON_EXTRACT(${drovrOutbox.heldContinuation}, '$.replayProof.waitingForStop')) = 'BOOLEAN' AND JSON_EXTRACT(${drovrOutbox.heldContinuation}, '$.replayProof.waitingForStop') = JSON_EXTRACT('true', '$')`,
							notInArray(drovrOutbox.eventType, [
								...DROVR_OUTBOX_STOP_EVENT_TYPES,
							]),
						),
					)
				return affectedRows(result)
			})),
		deleteDeliveredBefore: (before, limit) =>
			guarded(async () => {
				if (!Number.isSafeInteger(limit) || limit < 0) throw new HeldBatchContinuationError({ reason: 'the purge candidate budget is invalid; no evidence was deleted' })
				if (!limit) return 0
				if (typeof db.transaction !== 'function') throw new HeldBatchContinuationError({ reason: 'transactional storage is required for pin-aware purge; no evidence was deleted' })
				const now = Date.parse(before) + DROVR_OUTBOX_DELIVERED_RETENTION_MS
				return writeHeldContinuationGuard(() => retryHeldBatchTransaction(() => db.transaction(async tx => {
					const readPins = async (lock: boolean) => {
						const read = async () => {
							const query = tx.select({ target: drovrOutbox.target, key: drovrOutbox.dedupeKey, heldContinuation: drovrOutbox.heldContinuation }).from(drovrOutbox).where(and(inArray(drovrOutbox.status, [...DROVR_OUTBOX_WIRE_STATUSES]), sql`JSON_CONTAINS_PATH(${drovrOutbox.heldContinuation}, 'one', '$.continuation')`)).orderBy(asc(drovrOutbox.dedupeKey)).limit(HELD_BATCH_PIN_SCAN_MAX_COORDINATORS + 1)
							return await (lock ? query.for('update') : query) as { target: string; key: string; heldContinuation: unknown }[]
						}
						const rows = await readWithHeldContinuationFallback(read, async () => [])
						return collectHeldBatchPins(rows.map(row => {
							const state = readOutboxQueueState(row.heldContinuation)
							if (state.invalid) throw new HeldBatchContinuationError({ reason: 'the coordinator diagnostic proof is invalid; purge is refused' })
							return { target: row.target, key: row.key, encoded: state.heldBatch }
						}), now)
					}
					// The first read avoids starving unreferenced receipts behind old
					// pinned rows. It is NOT the authorization to delete anything.
					const snapshot = await readPins(false)
					const groups = new Map<string, string[]>()
					for (const member of snapshot.members) {
						let keys = groups.get(member.target)
						if (!keys) { keys = []; groups.set(member.target, keys) }
						keys.push(member.key)
					}
					const excluded = [...groups].map(([target, keys]) => and(eq(drovrOutbox.target, target), inArray(drovrOutbox.dedupeKey, keys)))
					const candidates: ProfileAckPurgeCandidate[] = await tx.select({ id: drovrOutbox.id, target: drovrOutbox.target, dedupeKey: drovrOutbox.dedupeKey, heldContinuation: drovrOutbox.heldContinuation }).from(drovrOutbox).where(and(eq(drovrOutbox.status, 'delivered'), lte(drovrOutbox.deliveredAt, toSqlTimestamp(before)), excluded.length ? sql`NOT (${or(...excluded)})` : undefined)).orderBy(asc(drovrOutbox.dedupeKey)).limit(Math.min(limit, DROVR_OUTBOX_PURGE_BATCH)).for('update')
					if (!candidates.length) return 0
					// A CURRENT locking read (not the transaction snapshot) sees
					// pins registered before these member locks were obtained.
					// Registration itself locks references before writing metadata.
					const current = await readPins(true)
					const unpinned = unpinnedDeliveredCandidates(candidates, current.pinned)
					if (!unpinned.length) return 0
					return protectProfileAckPurge({
						transaction: tx,
						candidates: unpinned,
						enabled: options.profileAckEnabled ?? (async () => {
							const { profileAckEnabled } = await import('./contact-sync-profile-ack-flag-live')
							return profileAckEnabled()
						}),
						deleteCandidates: async () => {
							const result = await tx.delete(drovrOutbox).where(and(inArray(drovrOutbox.id, unpinned.map(row => row.id)), eq(drovrOutbox.status, 'delivered'), lte(drovrOutbox.deliveredAt, toSqlTimestamp(before))))
							return affectedRows(result)
						},
					})
				})))
			}),
	}
}
