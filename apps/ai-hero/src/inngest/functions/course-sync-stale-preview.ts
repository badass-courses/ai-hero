import { remindStaleCourseSyncPreview } from '@/course-sync/stale-preview'
import {
	appendCourseSyncPollLog,
	claimCourseSyncReviewNotification,
	completeCourseSyncReviewNotification,
	failCourseSyncReviewNotification,
	getCourseSyncPollState,
} from '@/course-sync/detection-persistence'
import { courseSyncControlPlane } from '@/course-sync/runtime'
import { COURSE_SYNC_STALE_PREVIEW_EVENT } from '../events/course-sync-stale-preview'
import { inngest } from '../inngest.server'
import { notifyCourseSync } from './course-sync-detection-poller'

export const courseSyncStalePreview = inngest.createFunction(
	{
		id: 'course-sync-stale-preview',
		name: 'Remind Held Course Sync Preview',
		retries: 3,
	},
	{ event: COURSE_SYNC_STALE_PREVIEW_EVENT },
	async ({ event, step }) => {
		// Sleep until the hold's actual deadline, not 15 minutes after a delayed event delivery.
		const dueAt = new Date(new Date(event.data.heldAt).getTime() + 15 * 60_000)
		await step.sleepUntil('wait-15-minutes-after-hold', dueAt)
		return step.run('remind-if-preview-still-held', () =>
			remindStaleCourseSyncPreview(event.data, {
				getPollState: getCourseSyncPollState,
				getRun: courseSyncControlPlane.getRun,
				evaluateBoundedAutoApply:
					courseSyncControlPlane.evaluateBoundedAutoApply,
				claimReviewNotification: claimCourseSyncReviewNotification,
				completeReviewNotification: completeCourseSyncReviewNotification,
				failReviewNotification: failCourseSyncReviewNotification,
				notify: notifyCourseSync,
				appendLog: appendCourseSyncPollLog,
			}),
		)
	},
)
