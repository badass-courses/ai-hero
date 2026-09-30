import { captureDrovrOutbox, drovrOutboxTarget } from './drovr-outbox'
import { httpStatusOf, type DrovrOutboxCaptureFn } from './drovr-outbox-step'

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
		log,
	})
}
