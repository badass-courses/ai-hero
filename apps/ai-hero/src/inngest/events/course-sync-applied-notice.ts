export const COURSE_SYNC_APPLIED_NOTICE_EVENT =
	'course-sync/applied-notice.requested' as const

export type CourseSyncAppliedNoticeRequested = {
	name: typeof COURSE_SYNC_APPLIED_NOTICE_EVENT
	data: {
		bindingId: string
		controlPlaneRunId: string
		requestedBy: 'operator' | 'poller' | 'backfill'
	}
}
