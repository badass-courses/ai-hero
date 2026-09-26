import {
	activeCourseSyncBindings,
	type CourseSyncBinding,
} from '@/course-sync/types'

import { COURSE_SYNC_POLL_REQUESTED_EVENT } from '../events/course-sync-poll'
import { inngest } from '../inngest.server'

export const COURSE_SYNC_POLL_CRON = 'TZ=UTC */30 * * * *'

export function scheduledCourseSyncPollEvents(
	bindings: ReadonlyArray<CourseSyncBinding> = activeCourseSyncBindings(),
) {
	return bindings
		.filter((binding) => binding.status === 'active')
		.map((binding) => ({
			name: COURSE_SYNC_POLL_REQUESTED_EVENT,
			data: {
				bindingId: binding.bindingId,
				requestedBy: 'cron' as const,
				reason: 'scheduled-30-minute-poll',
			},
		}))
}

export const courseSyncPollScheduler = inngest.createFunction(
	{
		id: 'ai-hero-course-sync-poll-scheduler',
		name: 'AI Hero Course Sync Poll Scheduler',
	},
	{ cron: COURSE_SYNC_POLL_CRON },
	async ({ step }) => {
		const events = scheduledCourseSyncPollEvents()
		if (events.length > 0) {
			await step.sendEvent('fan-out-course-sync-polls', events)
		}
		return { scheduled: events.length }
	},
)
