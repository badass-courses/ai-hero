import {
	captureDrovrOutbox,
	holdDrovrStops,
	settleDrovrOutbox,
	drovrOutboxTarget,
	DrovrOutboxUnavailableError,
	isOutboxStop,
	drovrOutboxDedupeKey,
	type DrovrOutboxEntry,
	type DrovrOutboxOpenGate,
} from './drovr-outbox'
import {
	httpStatusOf,
	type DrovrOutboxCaptureFn,
	type DrovrOutboxHoldFn,
	type DrovrOutboxSettleFn,
} from './drovr-outbox-step'

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
	const [{ db }, { log }, { createDrizzleDrovrOutboxStore }] =
		await Promise.all([
			import('@/db'),
			import('@/server/logger'),
			import('./drovr-outbox-drizzle'),
		])
	return captureDrovrOutbox({
		store: createDrizzleDrovrOutboxStore(db),
		target: drovrOutboxTargetFromEnv(),
		entries,
		reason,
		httpStatus: httpStatusOf(reason),
		now: new Date(),
		...(options?.nextAttemptAt ? { nextAttemptAt: options.nextAttemptAt } : {}),
		log,
	})
}

/** settleDrovrOutbox against this deployment's database and target. */
export const settleDrovrOutboxLive: DrovrOutboxSettleFn = async (
	entries,
	note,
) => {
	const [{ db }, { log }, { createDrizzleDrovrOutboxStore }] =
		await Promise.all([
			import('@/db'),
			import('@/server/logger'),
			import('./drovr-outbox-drizzle'),
		])
	return settleDrovrOutbox({
		store: createDrizzleDrovrOutboxStore(db),
		target: drovrOutboxTargetFromEnv(),
		entries,
		note,
		now: new Date(),
		log,
	})
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
	'id' | 'contactId' | 'eventType' | 'occurredAt' | 'status'
>

export type DrovrOutboxOpenStopsFn = (
	contactIds: readonly string[],
) => Promise<DrovrOutboxOpenStop[]>

/**
 * This deployment's owed stops for these contacts. With no table yet
 * nothing can be owed, so that reads as none; any other failure throws
 * (the caller retries, and never posts on a failed read).
 */
export const openDrovrOutboxStopsLive: DrovrOutboxOpenStopsFn = async (
	contactIds,
) => {
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
		return gates.filter(isOutboxStop)
	} catch (error) {
		if (error instanceof DrovrOutboxUnavailableError) return []
		throw error
	}
}

/** A replay that won the timeout race must not cause another bulk POST. */
export async function deliveredDrovrOutboxKeysLive(entries: readonly DrovrOutboxEntry[]): Promise<string[]> {
	const target = drovrOutboxTargetFromEnv()
	if (!target || !entries.length) return []
	const [{ db }, { drovrOutbox }, { and, eq, inArray }] = await Promise.all([import('@/db'), import('@/db/drovr-outbox-schema'), import('drizzle-orm')])
	try {
		const rows = await db.select({ key: drovrOutbox.idempotencyKey }).from(drovrOutbox).where(and(eq(drovrOutbox.target, target), eq(drovrOutbox.status, 'delivered'), inArray(drovrOutbox.dedupeKey, entries.map(entry => drovrOutboxDedupeKey(target, entry)))))
		return rows.map(row => row.key)
	} catch (error) {
		// Legacy bulk writers may predate this optional table. A strict delta
		// cannot be queued without it; any other failed read must fail closed.
		if (error instanceof Error && /doesn't exist|does not exist/.test(error.message)) return []
		throw error
	}
}

/** Final refusals are alerted, never scheduled forever as a queued row. */
export async function rejectDrovrOutboxLive(entries: readonly DrovrOutboxEntry[], note: string, httpStatus: number): Promise<void> {
	const target = drovrOutboxTargetFromEnv()
	if (!target || !entries.length) return
	const captured = await captureDrovrOutboxLive(entries, note)
	if (captured.status !== 'outboxed') throw new Error('OutboxRefusal: you recorded a final refusal, and it failed because the row could not be persisted. Accepted: a retained terminal row. Fix: restore outbox storage. Debug: inspect the capture receipt.')
	const [{ db }, { drovrOutbox }, { and, eq, inArray }] = await Promise.all([import('@/db'), import('@/db/drovr-outbox-schema'), import('drizzle-orm')])
	await db.update(drovrOutbox).set({ status: 'rejected', lastError: note, lastStatus: httpStatus }).where(and(eq(drovrOutbox.target, target), eq(drovrOutbox.status, 'pending'), inArray(drovrOutbox.dedupeKey, entries.map(entry => drovrOutboxDedupeKey(target, entry)))))
}
