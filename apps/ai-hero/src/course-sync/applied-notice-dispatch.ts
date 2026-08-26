import { COURSE_SYNC_APPLIED_NOTICE_EVENT } from '@/inngest/events/course-sync-applied-notice'
import { inngest } from '@/inngest/inngest.server'
import { log } from '@/server/logger'

import { AI_HERO_COURSE_SYNC_BINDING } from './types'

/**
 * Asking for the notice is deliberately cheap and non-blocking. A caller that
 * moved a run to applied has already done the work that matters, so a Slack
 * outage or a slow narration must not turn its success into an error.
 */
export async function requestCourseSyncAppliedNotice(input: {
	controlPlaneRunId: string
	requestedBy: 'operator' | 'poller' | 'backfill'
	bindingId?: string
}): Promise<void> {
	const bindingId = input.bindingId ?? AI_HERO_COURSE_SYNC_BINDING.bindingId
	try {
		await inngest.send({
			name: COURSE_SYNC_APPLIED_NOTICE_EVENT,
			data: {
				bindingId,
				controlPlaneRunId: input.controlPlaneRunId,
				requestedBy: input.requestedBy,
			},
		})
	} catch (error) {
		await log.error('course_sync.applied_notice.dispatch_failed', {
			bindingId,
			controlPlaneRunId: input.controlPlaneRunId,
			error: error instanceof Error ? error.message : String(error),
		})
	}
}
