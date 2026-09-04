import { deliverCourseSyncAppliedNotice } from '@/course-sync/applied-notice'
import { inngest } from '@/inngest/inngest.server'

import { COURSE_SYNC_APPLIED_NOTICE_EVENT } from '../events/course-sync-applied-notice'

/**
 * One owner for the applied notice. Whoever moved the run to applied only has
 * to say so; the claim inside the deliverer keeps a retry or a second caller
 * from posting the message twice.
 */
export const courseSyncAppliedNotice = inngest.createFunction(
	{
		id: 'course-sync-applied-notice',
		name: 'Course Sync Applied Notice',
		retries: 3,
	},
	{ event: COURSE_SYNC_APPLIED_NOTICE_EVENT },
	async ({ event, runId }) => {
		return deliverCourseSyncAppliedNotice({
			bindingId: event.data.bindingId,
			controlPlaneRunId: event.data.controlPlaneRunId,
			pollRunId: runId,
		})
	},
)
