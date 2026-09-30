import {
	captureDrovrOutbox,
	settleDrovrOutbox,
	drovrOutboxTarget,
	DrovrOutboxUnavailableError,
	isOutboxStop,
	type DrovrOutboxOpenGate,
} from './drovr-outbox'
import {
	httpStatusOf,
	type DrovrOutboxCaptureFn,
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
