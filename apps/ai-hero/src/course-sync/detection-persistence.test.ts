import { MySqlDialect } from 'drizzle-orm/mysql-core'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const dbMock = vi.hoisted(() => ({ transaction: vi.fn() }))

vi.mock('@/db', () => ({ db: dbMock }))
vi.mock('@/server/logger', () => ({ log: { info: vi.fn() } }))

import {
	courseSyncRevisionHeadWhere,
	saveCourseSyncPollState,
} from './detection-persistence'
import type { CourseSyncPollState } from './detection-poller'

function pollState(
	status: CourseSyncPollState['status'],
	updatedAt: string,
): CourseSyncPollState {
	return {
		bindingId: 'csb_ai_coding_crash_course',
		courseVersionId: 'version-1',
		providerRevision: 'dropbox-rev-1',
		status,
		consecutiveFailures: status === 'held' ? 1 : 0,
		controlPlaneRunId: 'run-1',
		failureClass: status === 'held' ? 'APPLIED_RUN_ROLLED_BACK' : null,
		updatedAt: new Date(updatedAt),
	}
}

describe('course-sync revision head persistence', () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it('excludes compensating rollback runs from successful head selection', () => {
		const dialect = new MySqlDialect()
		const condition = courseSyncRevisionHeadWhere(
			'csb_ai_coding_crash_course',
		)
		if (!condition) throw new Error('revision-head condition missing')
		const query = dialect.sqlToQuery(condition.getSQL())

		expect(query.sql).toContain('`AI_CourseSyncRun`.`rollbackOfRunId` is null')
	})

	it('keeps a rollback hold when a stale succeeded save acquires the lock later', async () => {
		const insert = vi.fn()
		const lockedRows = [
			[{ bindingId: 'csb_ai_coding_crash_course' }],
			[pollState('held', '2026-08-16T19:00:00.000Z')],
		]
		const trx = {
			select: vi.fn(() => {
				const rows = lockedRows.shift() ?? []
				const query = {
					from: vi.fn(),
					where: vi.fn(),
					for: vi.fn(async () => rows),
				}
				query.from.mockReturnValue(query)
				query.where.mockReturnValue(query)
				return query
			}),
			insert,
		}
		dbMock.transaction.mockImplementationOnce(
			async (run: (transaction: typeof trx) => Promise<void>) => run(trx),
		)

		await saveCourseSyncPollState(
			pollState('succeeded', '2026-08-16T18:59:59.000Z'),
		)

		expect(trx.select).toHaveBeenCalledTimes(2)
		expect(insert).not.toHaveBeenCalled()
	})
})
