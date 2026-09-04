export const COURSE_SYNC_POLL_REQUESTED_EVENT =
	'course-sync/poll.requested' as const

export type CourseSyncPollRequested = {
	name: typeof COURSE_SYNC_POLL_REQUESTED_EVENT
	data: {
		bindingId: string
		requestedBy: 'operator'
		reason: string
	}
}
