import {
	captureDrovrOutbox,
	holdDrovrStops,
	settleDrovrOutbox,
	drovrOutboxTarget,
	DrovrOutboxUnavailableError,
	DROVR_OUTBOX_DEFERRED_STOP_WAIT_MS,
	isOutboxStop,
	isDrovrOutboxStatus,
	drovrOutboxDedupeKey,
	type DrovrOutboxWorkState,
	type DrovrOutboxEntry,
	type DrovrOutboxOpenGate,
} from './drovr-outbox'
import {
	httpStatusOf,
	type DrovrOutboxCaptureFn,
	type DrovrOutboxHoldFn,
	type DrovrOutboxSettleFn,
} from './drovr-outbox-step'
import { DROVR_OUTBOX_WIRE_STATUSES } from './drovr-outbox-wire-status'

/** This deployment's outbox target (drovrOutboxTarget). */
export const drovrOutboxTargetFromEnv = () =>
	drovrOutboxTarget({
		VERCEL_ENV: process.env.VERCEL_ENV,
		VERCEL_GIT_COMMIT_REF: process.env.VERCEL_GIT_COMMIT_REF,
	})

/**
 * The outbox write against this deployment's database and target. Lazy:
 * the dispatch module that calls it must not pull the database in at load.
 */
export const captureDrovrOutboxLive: DrovrOutboxCaptureFn = async (
	entries,
	reason,
	options,
) => {
	const [{ db }, { log }, { createDrizzleDrovrOutboxStore, withQueueDiagnostic, queueEnvelope }] =
		await Promise.all([
			import('@/db'),
			import('@/server/logger'),
			import('./drovr-outbox-drizzle'),
		])
	const now = new Date()
	const target = drovrOutboxTargetFromEnv()
	const deferred = options?.status === 'deferred'
	const waiting = options?.waitingForStop === true
	const nextAttemptAt = options?.nextAttemptAt ?? (deferred || waiting ? new Date(now.getTime() + DROVR_OUTBOX_DEFERRED_STOP_WAIT_MS) : undefined)
	const captured = await captureDrovrOutbox({
		store: createDrizzleDrovrOutboxStore(db),
		target: drovrOutboxTargetFromEnv(),
		entries,
		reason,
		httpStatus: deferred ? 409 : httpStatusOf(reason),
		now,
		...(deferred ? { status: 'deferred' as const } : {}),
		...(nextAttemptAt ? { nextAttemptAt } : {}),
		log,
	})
	// A real final failure releases queue ownership. INSERT IGNORE preserves
	// immutable bytes, but by itself would leave an existing +24h lease.
	if (captured.status === 'outboxed' && target && entries.length && (deferred || waiting || (reason !== undefined && !options?.nextAttemptAt))) {
		const [{ drovrOutbox }, { and, eq, inArray, sql }, { writeHeldContinuationGuard }] = await Promise.all([import('@/db/drovr-outbox-schema'), import('drizzle-orm'), import('./drovr-outbox-control')])
		const heldContinuation = waiting ? sql`JSON_SET(${queueEnvelope}, '$.replayProof.waitingForStop', JSON_EXTRACT('true', '$'))` : sql`JSON_REMOVE(${drovrOutbox.heldContinuation}, '$.replayProof.waitingForStop', '$.ownerStopRejection')`
		await writeHeldContinuationGuard(() => db.update(drovrOutbox).set({ nextAttemptAt: (nextAttemptAt ?? now).toISOString().replace('T', ' ').replace('Z', ''), heldContinuation, lastError: withQueueDiagnostic(reason === undefined ? null : (reason instanceof Error ? reason.message : String(reason)).slice(0, 1000)), ...(waiting ? {} : { status: deferred ? 'deferred' : 'pending', lastStatus: deferred ? 409 : httpStatusOf(reason) ?? null }), ...(deferred ? { lastAttemptAt: now.toISOString().replace('T', ' ').replace('Z', '') } : {}) }).where(and(eq(drovrOutbox.target, target), inArray(drovrOutbox.status, ['pending', 'deferred']), inArray(drovrOutbox.dedupeKey, entries.map(entry => drovrOutboxDedupeKey(target, entry))))))
	}
	return captured
}

/** settleDrovrOutbox against this deployment's database and target. */
export const settleDrovrOutboxLive: DrovrOutboxSettleFn = async (
	entries,
	note,
	proof,
) => {
	if (proof?.profileAckRef) {
		const ref = proof.profileAckRef, row = entries[0]
		if (entries.length !== 1 || !row || row.endpoint !== 'events' || row.tenantId !== ref.tenantId || row.contactId !== ref.contactId || row.journeyId !== ref.journeyId || !['contact.profile.updated', 'contact.links.issued'].includes(row.eventType ?? '') || (row.body as { payload?: { profileVersion?: unknown } })?.payload?.profileVersion !== ref.profileVersion) {
			const { ProfileAckConflict } = await import('./contact-sync-profile-ack')
			throw new ProfileAckConflict('the SDK native settlement must name one matching frozen profile/link member, not a mixed request or counter')
		}
	}
	const [{ db }, { log }, { createDrizzleDrovrOutboxStore }] =
		await Promise.all([
			import('@/db'),
			import('@/server/logger'),
			import('./drovr-outbox-drizzle'),
		])
	let completion: import('./contact-sync-profile-ack-completion-live').ProfileAckWorkerCompletion = proof?.profileAckRef ? { _tag: 'ProfileAckAwaitingProof' } : undefined
	const settled = await settleDrovrOutbox({
		store: createDrizzleDrovrOutboxStore(db, { onProfileAckSettlement: result => {
			if (!proof?.profileAckRef) return
			if (result._tag === 'ProfileAckDisabled') { completion = { _tag: 'ProfileAckAwaitingProof' }; return }
			completion = result.evaluation._tag === 'AckEvidenceExpired' ? result.evaluation : result.evaluation._tag === 'ProfileAckReady' ? undefined : { _tag: 'ProfileAckAwaitingProof' }
		} }),
		target: drovrOutboxTargetFromEnv(),
		entries,
		note,
		receiverAccepted: proof?.receiverAccepted === true,
		now: new Date(),
		log,
	})
	return completion ?? settled
}

/** holdDrovrStops against this deployment's database and target (row 204c). */
export const holdDrovrStopsLive: DrovrOutboxHoldFn = async (
	entries,
	reason,
	httpStatus,
) => {
	const [{ db }, { log }, { createDrizzleDrovrOutboxStore }] =
		await Promise.all([
			import('@/db'),
			import('@/server/logger'),
			import('./drovr-outbox-drizzle'),
		])
	return holdDrovrStops({
		store: createDrizzleDrovrOutboxStore(db),
		target: drovrOutboxTargetFromEnv(),
		entries,
		reason,
		...(httpStatus === undefined ? {} : { httpStatus }),
		now: new Date(),
		log,
	})
}

/** A stop the outbox still owes, as the live gate reads it (row 204b). */
export type DrovrOutboxOpenStop = Pick<
	DrovrOutboxOpenGate,
	'id' | 'contactId' | 'eventType' | 'occurredAt' | 'status' | 'supersededAt'
>

export type DrovrOutboxOpenStopsFn = (
	contactIds: readonly string[],
) => Promise<DrovrOutboxOpenStop[]>

/**
 * This deployment's owed stops for these contacts. With no table yet
 * nothing can be owed, so that reads as none; any other failure throws
 * (the caller retries, and never posts on a failed read).
 */
export const openDrovrOutboxGatesLive = async (
	contactIds: readonly string[],
): Promise<DrovrOutboxOpenGate[]> => {
	if (contactIds.length === 0) return []
	const [{ db }, { createDrizzleDrovrOutboxStore }] = await Promise.all([
		import('@/db'),
		import('./drovr-outbox-drizzle'),
	])
	try {
		const gates = await createDrizzleDrovrOutboxStore(db).openGates({
			target: drovrOutboxTargetFromEnv(),
			contactIds,
		})
		return gates
	} catch (error) {
		if (error instanceof DrovrOutboxUnavailableError) return []
		throw error
	}
}

export const openDrovrOutboxStopsLive: DrovrOutboxOpenStopsFn = async (contactIds) =>
	(await openDrovrOutboxGatesLive(contactIds)).filter(isOutboxStop)

/** One scoped disposition read replaces the delivered-only race check. Missing
 * rows remain missing; a strict owner must not turn absence into permission. */
export async function drovrOutboxWorkStatesLive(entries: readonly DrovrOutboxEntry[]): Promise<DrovrOutboxWorkState[]> {
	const target = drovrOutboxTargetFromEnv()
	if (!target || !entries.length) return []
	const [{ db }, { drovrOutbox }, { and, eq, inArray }, { supersededUnsubscribeAt, supersedingResubscribeAt }, { readOutboxQueueState }, { decodeHeldBatchContinuation, HeldBatchContinuationError }] = await Promise.all([import('@/db'), import('@/db/drovr-outbox-schema'), import('drizzle-orm'), import('./drovr-unsubscribe-supersession'), import('./drovr-outbox-queue-state'), import('./contact-sync-held-batch')])
	const { readWithHeldContinuationFallback } = await import('./drovr-outbox-control')
	const fields = { key: drovrOutbox.dedupeKey, target: drovrOutbox.target, endpoint: drovrOutbox.endpoint, tenantId: drovrOutbox.tenantId, contactId: drovrOutbox.contactId, journeyId: drovrOutbox.journeyId, idempotencyKey: drovrOutbox.idempotencyKey, body: drovrOutbox.body, status: drovrOutbox.status, eventType: drovrOutbox.eventType, occurredAt: drovrOutbox.occurredAt, lastError: drovrOutbox.lastError }
	const query = (held: boolean) => db.select({ ...fields, ...(held ? { heldContinuation: drovrOutbox.heldContinuation } : {}) }).from(drovrOutbox).where(and(eq(drovrOutbox.target, target), inArray(drovrOutbox.status, [...DROVR_OUTBOX_WIRE_STATUSES]), inArray(drovrOutbox.dedupeKey, entries.map(entry => drovrOutboxDedupeKey(target, entry)))))
	let controlUnavailable = false
	const rows = await readWithHeldContinuationFallback(() => query(true), () => { controlUnavailable = true; return query(false) })
	const fail = () => new Error('OutboxDisposition: you resumed owned work, and it failed because its retained disposition or closure proof is invalid. Accepted: a known scoped state and a strictly newer whole-second resubscribe for superseded unsubscriptions. Fix: keep the work held and restore its retained proof. Debug: inspect the target, full dedupe key and diagnostic, not a bare wire key.')
	return rows.map(row => {
		if (!isDrovrOutboxStatus(row.status)) throw fail()
		const queue = readOutboxQueueState(row.heldContinuation, row.lastError)
		if (queue.invalid) throw fail()
		let blocked = queue.heldBatchBlocked === true
		if ('heldBatch' in queue) {
			if (typeof queue.heldBatch !== 'string') throw new HeldBatchContinuationError({ reason: 'the anchor continuation is not encoded state' })
			const continuation = decodeHeldBatchContinuation(queue.heldBatch)
			if (continuation.target !== target || continuation.anchorKey !== row.key) throw new HeldBatchContinuationError({ reason: 'the stored continuation belongs to another scoped anchor' })
			blocked ||= continuation.release.state === 'held' || queue.invalid
		}
		if (row.status === 'superseded') {
			const lift = supersededUnsubscribeAt({ ...row, dedupeKey: row.key })
			if (!lift && controlUnavailable) return { key: row.key, status: row.status, heldBatchBlocked: true }
			const retainedAt: unknown = row.occurredAt
			const value = retainedAt instanceof Date ? retainedAt.getTime() : Date.parse(/(Z|[+-]\d{2}:?\d{2})$/.test(String(retainedAt)) ? String(retainedAt) : `${String(retainedAt).replace(' ', 'T')}Z`)
			if (!Number.isFinite(value) || !lift || !supersedingResubscribeAt({ eventType: row.eventType, occurredAt: new Date(value).toISOString() }, lift)) throw fail()
		}
		return { key: row.key, status: row.status, ...(blocked ? { heldBatchBlocked: true } : {}) }
	})
}

/** Compatibility for legacy callers; strict workers read all dispositions. */
export async function deliveredDrovrOutboxKeysLive(entries: readonly DrovrOutboxEntry[]): Promise<string[]> {
	const target = drovrOutboxTargetFromEnv()
	if (!target || !entries.length) return []
	try {
		const delivered = new Set((await drovrOutboxWorkStatesLive(entries)).filter(row => row.status === 'delivered').map(row => row.key))
		return entries.filter(entry => delivered.has(drovrOutboxDedupeKey(target, entry))).map(entry => entry.idempotencyKey)
	} catch (error) {
		// Legacy bulk writers may predate this optional table. A strict delta
		// cannot be queued without it; any other failed read must fail closed.
		if (error instanceof Error && /doesn't exist|does not exist/.test(error.message)) return []
		throw error
	}
}

/** Bounded operator read of logical holds, including closed native carriers.
 * No bodies, writes, automatic release or broker publication. */
export async function readHeldBatchDiagnosticsLive(args: { key?: string; limit?: number; includeEncoded?: boolean } = {}) {
	return (await import('./contact-sync-held-batch-live')).inspectHeldBatchesLive(args)
}

/** Final refusals are alerted, never scheduled forever as a queued row. */
export async function rejectDrovrOutboxLive(entries: readonly DrovrOutboxEntry[], note: string, httpStatus: number): Promise<void> {
	const target = drovrOutboxTargetFromEnv()
	if (!target || !entries.length) return
	const captured = await captureDrovrOutboxLive(entries, note)
	if (captured.status !== 'outboxed') throw new Error('OutboxRefusal: you recorded a final refusal, and it failed because the row could not be persisted. Accepted: a retained terminal row. Fix: restore outbox storage. Debug: inspect the capture receipt.')
	const [{ db }, { drovrOutbox }, { and, eq, inArray, sql }, { withQueueDiagnostic }, { writeHeldContinuationGuard }] = await Promise.all([import('@/db'), import('@/db/drovr-outbox-schema'), import('drizzle-orm'), import('./drovr-outbox-drizzle'), import('./drovr-outbox-control')])
	await writeHeldContinuationGuard(() => db.update(drovrOutbox).set({ status: 'rejected', heldContinuation: sql`JSON_REMOVE(${drovrOutbox.heldContinuation}, '$.ownerStopRejection')`, lastError: withQueueDiagnostic(note), lastStatus: httpStatus, lastAttemptAt: new Date().toISOString().replace('T', ' ').replace('Z', '') }).where(and(eq(drovrOutbox.target, target), inArray(drovrOutbox.status, ['pending', 'deferred']), inArray(drovrOutbox.dedupeKey, entries.map(entry => drovrOutboxDedupeKey(target, entry))))))
}
