import { log } from '@/server/logger'
import {
	getRunIdentity,
	isNonProdExecutorOnProdDb,
	type RunIdentity,
} from '@/server/run-identity'

const lastAlert = new Map<string, number>()
const HOUR = 60 * 60 * 1000

/** Observability is best-effort: it never changes poll state or fails a run. */
export async function logCourseSyncRunStart(
	run: { runId: string; executor: 'scheduler' | 'detection-poller' },
	dependencies: {
		identity?: RunIdentity
		now?: number
		notify: (identity: RunIdentity) => Promise<void>
	},
): Promise<void> {
	const runIdentity = dependencies.identity ?? getRunIdentity()
	try {
		await log.info('course_sync.run.started', { ...run, runIdentity })
	} catch {
		// Continue even when the log sink is unavailable.
	}
	if (!isNonProdExecutorOnProdDb(runIdentity)) return
	try {
		await log.warn('course_sync.nonprod_executor_on_prod_db', {
			...run,
			runIdentity,
		})
	} catch {
		// A warning transport failure is not a sync failure.
	}
	const now = dependencies.now ?? Date.now()
	// Bound memory and dedupe across scheduler/poller in this executor process.
	for (const [key, at] of lastAlert) {
		if (now - at >= HOUR) lastAlert.delete(key)
	}
	const key = JSON.stringify([runIdentity.hostname, runIdentity.dbUsername])
	if (lastAlert.has(key)) return
	lastAlert.set(key, now)
	try {
		await dependencies.notify(runIdentity)
	} catch {
		// Never serialize a provider error; it may contain credentials.
		try {
			await log.warn('course_sync.executor_alert_failed', {
				...run,
				runIdentity,
			})
		} catch {
			// Observability must not fail the run.
		}
	}
}
