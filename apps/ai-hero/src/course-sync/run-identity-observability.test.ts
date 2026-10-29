import { beforeEach, describe, expect, it, vi } from 'vitest'

const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn() }))
vi.mock('@/server/logger', () => ({ log }))
import { buildRunIdentity } from '@/server/run-identity'
import { logCourseSyncRunStart } from './run-identity-observability'

const identity = {
	...buildRunIdentity({}, { hostname: 'executor.example.test' }),
	dbHost: 'region.psdb.cloud',
	dbUsername: 'observer',
}
const run = { runId: 'poll-test', executor: 'detection-poller' as const }

describe('course-sync executor warning', () => {
	beforeEach(() => {
		vi.resetAllMocks()
	})

	it('always warns; alerts once per executor host and username per hour', async () => {
		const notify = vi.fn(async () => undefined)
		for (const now of [0, 1, 60 * 60 * 1000]) {
			await logCourseSyncRunStart(run, { identity, now, notify })
		}
		expect(log.info).toHaveBeenCalledWith('course_sync.run.started', {
			...run,
			runIdentity: identity,
		})
		expect(log.warn).toHaveBeenCalledTimes(3)
		expect(log.warn).toHaveBeenCalledWith(
			'course_sync.nonprod_executor_on_prod_db',
			{ ...run, runIdentity: identity },
		)
		expect(notify).toHaveBeenCalledTimes(2)
		expect(notify).toHaveBeenCalledWith(identity)
	})

	it('does not warn or alert for Vercel production or non-prod databases', async () => {
		const notify = vi.fn()
		for (const safe of [
			{ ...identity, onVercel: true, vercelEnv: 'production' },
			{ ...identity, dbHost: 'db.example.test' },
		]) {
			await logCourseSyncRunStart(run, { identity: safe, notify })
		}
		expect(log.warn).not.toHaveBeenCalled()
		expect(notify).not.toHaveBeenCalled()
	})

	it('never fails a run if logging and alert transport fail', async () => {
		log.info.mockRejectedValue(new Error('sink unavailable'))
		log.warn.mockRejectedValue(new Error('sink unavailable'))
		const notify = vi.fn(async () => {
			throw new Error('transport unavailable')
		})
		await expect(
			logCourseSyncRunStart(run, {
				identity: { ...identity, hostname: 'other.example.test' },
				notify,
			}),
		).resolves.toBeUndefined()
		expect(notify).toHaveBeenCalledOnce()
	})
})
