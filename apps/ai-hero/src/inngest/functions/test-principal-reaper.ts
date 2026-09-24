import { db } from '@/db'
import { inngest } from '@/inngest/inngest.server'
import { TEST_PRINCIPAL_TTL_MS } from '@/lib/test-principals/test-principal'
import {
	deleteTestPrincipalRecords,
	expiredTestPrincipalIds,
} from '@/lib/test-principals/test-principal-store'
import { log } from '@/server/logger'

/**
 * A failed link-test run cannot leave a principal behind: every ten minutes,
 * principals past their hour are removed exactly as DELETE removes them.
 */
export const testPrincipalReaper = inngest.createFunction(
	{
		id: 'test-principal-reaper',
		name: 'Test Principal Reaper',
		concurrency: { limit: 1 },
	},
	{ cron: 'TZ=UTC */10 * * * *' },
	async ({ step }) => {
		const now = new Date()
		const cutoff = new Date(now.getTime() - TEST_PRINCIPAL_TTL_MS)
		const expired = await step.run('find expired test principals', () =>
			expiredTestPrincipalIds(db, { now, limit: 50 }),
		)
		let reaped = 0
		for (const principalId of expired) {
			// A principal re-minted after it was listed is live again: keep it.
			const deleted = await step.run(`reap ${principalId}`, () =>
				deleteTestPrincipalRecords(db, principalId, { createdBefore: cutoff }),
			)
			if (!deleted) continue
			reaped += 1
			await log.info('drovr.test_principal.deleted', {
				principalId,
				removed: deleted.removed,
				absentTables: deleted.absentTables,
				trigger: 'reaper',
			})
		}
		return { expired: expired.length, reaped }
	},
)
