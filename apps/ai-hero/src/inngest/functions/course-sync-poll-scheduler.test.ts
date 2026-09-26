import { describe, expect, it, vi } from 'vitest'

const createFunction = vi.hoisted(() =>
	vi.fn((options, trigger, handler) => ({ options, trigger, handler })),
)
vi.mock('../inngest.server', () => ({ inngest: { createFunction } }))

import {
	AI_HERO_COURSE_SYNC_BINDING,
	AI_HERO_COURSE_SYNC_BINDING_COHORT_005,
	COURSE_SYNC_BINDINGS,
} from '@/course-sync/types'
import { COURSE_SYNC_POLL_REQUESTED_EVENT } from '../events/course-sync-poll'
import {
	COURSE_SYNC_POLL_CRON,
	courseSyncPollScheduler,
	scheduledCourseSyncPollEvents,
} from './course-sync-poll-scheduler'

const syntheticBinding = {
	...AI_HERO_COURSE_SYNC_BINDING,
	bindingId: 'test-binding',
}

describe('course-sync poll scheduler', () => {
	it('keeps one 30-minute cron and emits one poll for each of the two bindings', async () => {
		expect(Object.keys(COURSE_SYNC_BINDINGS)).toEqual([
			AI_HERO_COURSE_SYNC_BINDING.bindingId,
			AI_HERO_COURSE_SYNC_BINDING_COHORT_005.bindingId,
		])
		expect(COURSE_SYNC_POLL_CRON).toBe('TZ=UTC */30 * * * *')
		expect(courseSyncPollScheduler).toBeDefined()
		const [, trigger, handler] = createFunction.mock.calls[0]!
		expect(trigger).toEqual({ cron: COURSE_SYNC_POLL_CRON })
		const sendEvent = vi.fn(async () => undefined)
		await expect(handler({ step: { sendEvent } })).resolves.toEqual({
			scheduled: 2,
		})
		expect(sendEvent).toHaveBeenCalledTimes(1)
		expect(sendEvent).toHaveBeenCalledWith('fan-out-course-sync-polls', [
			{
				name: COURSE_SYNC_POLL_REQUESTED_EVENT,
				data: {
					bindingId: AI_HERO_COURSE_SYNC_BINDING.bindingId,
					requestedBy: 'cron',
					reason: 'scheduled-30-minute-poll',
				},
			},
			{
				name: COURSE_SYNC_POLL_REQUESTED_EVENT,
				data: {
					bindingId: AI_HERO_COURSE_SYNC_BINDING_COHORT_005.bindingId,
					requestedBy: 'cron',
					reason: 'scheduled-30-minute-poll',
				},
			},
		])
	})

	it('fans out only active bindings (including synthetic test entries)', () => {
		expect(
			scheduledCourseSyncPollEvents([
				AI_HERO_COURSE_SYNC_BINDING,
				syntheticBinding,
				{ ...syntheticBinding, bindingId: 'paused', status: 'suspended' },
			]),
		).toHaveLength(2)
	})
})
