import type { HeldBatchAnchor } from './contact-sync-held-batch-persistence'
import { readOutboxQueueState } from './drovr-outbox-queue-state'
import { DROVR_OUTBOX_WIRE_STATUSES } from './drovr-outbox-wire-status'
import {
	HELD_BATCH_MAX_REFERENCES,
	HeldBatchContinuationError,
	decodeHeldBatchContinuation,
} from './contact-sync-held-batch'
import type { DrovrOutboxRow } from './drovr-outbox'
import type { HeldBatchReleasePersistence } from './contact-sync-held-batch-release'
import { retryHeldBatchTransaction } from './contact-sync-held-batch-transaction'
import {
	OUTBOX_CONTROL_MAX_ENCODED_BYTES,
	encodeHeldContinuationEnvelope,
	readHeldContinuationEnvelope,
	readWithHeldContinuationFallback,
	writeHeldContinuationGuard,
} from './drovr-outbox-control'

/** Bounded retained lookup. Ordinary readers tolerate an unavailable additive
 * column; acknowledgement authorization must read it strictly on every chunk. */
export async function heldBatchRowsLive(
	target: string,
	keys: readonly string[],
	options: { requireControl?: boolean } = {},
): Promise<DrovrOutboxRow[]> {
	if (
		keys.length > HELD_BATCH_MAX_REFERENCES ||
		new Set(keys).size !== keys.length ||
		keys.some((key) => !/^[a-f0-9]{64}$/.test(key))
	)
		throw new HeldBatchContinuationError({
			reason:
				'the retained lookup exceeds its reference cap or has invalid full keys',
		})
	if (!keys.length) return []
	const [
		{ db },
		{ drovrOutbox },
		{ and, eq, inArray, getTableColumns },
		{ fromStored, legacyOutboxColumns },
	] = await Promise.all([
		import('@/db'),
		import('@/db/drovr-outbox-schema'),
		import('drizzle-orm'),
		import('./drovr-outbox-drizzle'),
	])
	const columns = getTableColumns(drovrOutbox)
	const query = (fields: typeof legacyOutboxColumns) =>
		db
			.select(fields)
			.from(drovrOutbox)
			.where(
				and(
					eq(drovrOutbox.target, target),
					inArray(drovrOutbox.status, [...DROVR_OUTBOX_WIRE_STATUSES]),
					inArray(drovrOutbox.dedupeKey, [...keys]),
				),
			)
	return (
		await (options.requireControl
			? writeHeldContinuationGuard(() => query(columns))
			: readWithHeldContinuationFallback(
					() => query(columns),
					() => query(legacyOutboxColumns),
				))
	).map(fromStored)
}

/** Runtime never executes DDL/session SET or stores controls in lastError. */
export async function heldBatchPersistenceLive(): Promise<HeldBatchReleasePersistence> {
	const [
		{ db },
		{ drovrOutbox },
		{ and, eq, inArray, asc, sql },
		{ affectedRows, queueEnvelope },
	] = await Promise.all([
		import('@/db'),
		import('@/db/drovr-outbox-schema'),
		import('drizzle-orm'),
		import('./drovr-outbox-drizzle'),
	])
	const mutable = ['pending', 'deferred', 'held', 'rejected', 'superseded']
	const scope = (anchor: HeldBatchAnchor) =>
		and(
			eq(drovrOutbox.target, anchor.target),
			eq(drovrOutbox.dedupeKey, anchor.key),
			inArray(drovrOutbox.status, [...DROVR_OUTBOX_WIRE_STATUSES]),
		)
	const inspect = async (anchor: HeldBatchAnchor) => {
		const fields = {
			status: drovrOutbox.status,
			lastError: drovrOutbox.lastError,
		}
		const rows = await readWithHeldContinuationFallback(
			() =>
				db
					.select({ ...fields, heldContinuation: drovrOutbox.heldContinuation })
					.from(drovrOutbox)
					.where(scope(anchor))
					.limit(1),
			async () =>
				(
					await db
						.select(fields)
						.from(drovrOutbox)
						.where(scope(anchor))
						.limit(1)
				).map((row) => ({ ...row, heldContinuation: undefined })),
		)
		return rows[0]
	}
	const heldEnvelope = sql`JSON_SET(${queueEnvelope}, '$.continuation', COALESCE(JSON_EXTRACT(${drovrOutbox.heldContinuation}, '$.continuation'), JSON_OBJECT('v', 1, 'blocked', JSON_EXTRACT('true', '$'))))`
	const storedRoot = sql`JSON_UNQUOTE(JSON_EXTRACT(${drovrOutbox.heldContinuation}, '$.continuation.encoded'))`
	const unchanged = (previous: unknown) =>
		previous === undefined
			? sql`JSON_CONTAINS_PATH(${heldEnvelope}, 'one', '$.continuation.encoded') = 0`
			: typeof previous === 'string'
				? sql`${storedRoot} = BINARY ${previous}`
				: sql`JSON_EXTRACT(${heldEnvelope}, '$.continuation.encoded') = JSON_EXTRACT(${JSON.stringify(previous)}, '$')`
	const fits = (document: ReturnType<typeof sql>) =>
		sql`OCTET_LENGTH(${document}) <= ${OUTBOX_CONTROL_MAX_ENCODED_BYTES}`
	// Validate proposed controls with Effect before SQL, preserving the other
	// member. SQL size/CAS guards remain authoritative against concurrent edits.
	const validate = async (
		anchor: HeldBatchAnchor,
		change: { encoded?: string; blocked: boolean; reason?: string },
	) => {
		const row = await inspect(anchor)
		if (!row) return undefined
		const state = readHeldContinuationEnvelope(row.heldContinuation) ?? {
			v: 1 as const,
		}
		encodeHeldContinuationEnvelope({
			...state,
			continuation: { ...state.continuation, v: 1, ...change },
		})
		return row
	}
	return {
		block: (anchor, reason, expected) =>
			writeHeldContinuationGuard(async () => {
				if (!(await validate(anchor, { blocked: true, reason }))) return false
				const released = sql`IF(JSON_VALID(${storedRoot}), IFNULL(JSON_UNQUOTE(JSON_EXTRACT(${storedRoot}, '$.release.state')) = BINARY 'released', FALSE), FALSE)`
				const permission = expected?.releaseId
					? sql`IF(JSON_VALID(${storedRoot}), ${released} AND JSON_UNQUOTE(JSON_EXTRACT(${storedRoot}, '$.release.id')) = BINARY ${expected.releaseId} AND JSON_UNQUOTE(JSON_EXTRACT(${storedRoot}, '$.completion.state')) = BINARY 'unfinished', FALSE)`
					: expected && 'encoded' in expected
						? sql`TRUE`
						: sql`NOT ${released}`
				const allowed = sql`(${inArray(drovrOutbox.status, mutable)} OR (${drovrOutbox.status} = 'delivered' AND ${expected?.releaseId !== undefined} AND ${permission}))`
				const document = sql`JSON_SET(${heldEnvelope}, '$.continuation.blocked', JSON_EXTRACT('true', '$'), '$.continuation.reason', ${reason})`
				const result = await db
					.update(drovrOutbox)
					.set({
						status: sql`IF(${drovrOutbox.status} IN ('pending', 'deferred'), 'held', ${drovrOutbox.status})`,
						heldContinuation: document,
					})
					.where(
						and(
							scope(anchor),
							allowed,
							permission,
							expected && 'encoded' in expected
								? unchanged(expected.encoded)
								: sql`TRUE`,
							fits(document),
						),
					)
				if (affectedRows(result) > 0) return true
				const row = await inspect(anchor)
				if (!row) return false
				const state = readOutboxQueueState(row.heldContinuation, row.lastError)
				const current =
					typeof state.heldBatch === 'string'
						? decodeHeldBatchContinuation(state.heldBatch)
						: undefined
				const matches =
					current?.release.state === 'released' &&
					current.release.id === expected?.releaseId &&
					current.completion.state === 'unfinished' &&
					current.target === anchor.target &&
					current.anchorKey === anchor.key
				return (
					!state.invalid &&
					(mutable.includes(row.status) ||
						(row.status === 'delivered' && matches)) &&
					state.heldBatchBlocked === true &&
					(expected?.releaseId
						? matches
						: expected && 'encoded' in expected
							? true
							: current?.release.state !== 'released') &&
					(expected === undefined ||
						!('encoded' in expected) ||
						JSON.stringify(state.heldBatch) ===
							JSON.stringify(expected.encoded))
				)
			}),
		read: async (anchor) => {
			const row = await inspect(anchor)
			if (!row) return undefined
			const state = readOutboxQueueState(row.heldContinuation, row.lastError)
			return { encoded: state.heldBatch, invalid: state.invalid }
		},
		finish: ({ anchor, previous, encoded }) =>
			writeHeldContinuationGuard(async () => {
				const before = decodeHeldBatchContinuation(previous)
				const after = decodeHeldBatchContinuation(encoded)
				if (
					before.completion.state !== 'unfinished' ||
					after.completion.state !== 'completed' ||
					after.target !== anchor.target ||
					after.anchorKey !== anchor.key ||
					JSON.stringify({ ...after, completion: before.completion }) !==
						JSON.stringify(before)
				)
					return false
				if (!(await validate(anchor, { encoded, blocked: false }))) return false
				const document = sql`JSON_SET(${heldEnvelope}, '$.continuation.encoded', ${encoded}, '$.continuation.blocked', JSON_EXTRACT('false', '$'))`
				return (
					affectedRows(
						await db
							.update(drovrOutbox)
							.set({ heldContinuation: document })
							.where(and(scope(anchor), unchanged(previous), fits(document))),
					) > 0
				)
			}),
		release: ({ anchor, previous, encoded, now }) =>
			writeHeldContinuationGuard(async () => {
				if (
					!Number.isFinite(Date.parse(now)) ||
					new Date(now).toISOString() !== now
				)
					return false
				if (!(await validate(anchor, { encoded, blocked: false }))) return false
				// SET schema ordering cannot change this pending-wire predicate.
				const pending = sql`${drovrOutbox.status} IN ('pending', 'held', 'deferred')`
				const document = sql`JSON_SET(JSON_REMOVE(${heldEnvelope}, '$.replayProof.publicationId', '$.continuation.reason'), '$.continuation.encoded', ${encoded}, '$.continuation.blocked', JSON_EXTRACT('false', '$'), '$.replayProof.handoffs', IF(${pending}, 0, JSON_EXTRACT(${queueEnvelope}, '$.replayProof.handoffs')))`
				return (
					affectedRows(
						await db
							.update(drovrOutbox)
							.set({
								status: sql`IF(${drovrOutbox.status} IN ('held', 'deferred'), 'pending', ${drovrOutbox.status})`,
								heldContinuation: document,
								nextAttemptAt: sql`IF(${pending}, ${now.slice(0, 23).replace('T', ' ')}, ${drovrOutbox.nextAttemptAt})`,
							})
							.where(and(scope(anchor), unchanged(previous), fits(document))),
					) > 0
				)
			}),
		put: ({ anchor, previous, encoded }) =>
			writeHeldContinuationGuard(async () => {
				if (previous !== undefined && typeof previous !== 'string') return false
				const root = decodeHeldBatchContinuation(encoded)
				if (root.target !== anchor.target || root.anchorKey !== anchor.key)
					return false
				if (!(await validate(anchor, { encoded, blocked: true }))) return false
				return retryHeldBatchTransaction(() =>
					db.transaction(async (tx) => {
						const references = await tx
							.select({ key: drovrOutbox.dedupeKey })
							.from(drovrOutbox)
							.where(
								and(
									eq(drovrOutbox.target, anchor.target),
									inArray(
										drovrOutbox.dedupeKey,
										root.members.map((member) => member.key),
									),
								),
							)
							.orderBy(asc(drovrOutbox.dedupeKey))
							.for('update')
						if (references.length !== root.members.length) return false
						const document = sql`JSON_SET(${heldEnvelope}, '$.continuation.encoded', ${encoded}, '$.continuation.blocked', JSON_EXTRACT('true', '$'))`
						return (
							affectedRows(
								await tx
									.update(drovrOutbox)
									.set({ heldContinuation: document })
									.where(
										and(
											scope(anchor),
											sql`(${inArray(drovrOutbox.status, ['held', 'rejected', 'superseded'])} OR (${drovrOutbox.status} = 'delivered' AND ${previous !== undefined}))`,
											unchanged(previous),
											fits(document),
										),
									),
							) > 0
						)
					}),
				)
			}),
	}
}
