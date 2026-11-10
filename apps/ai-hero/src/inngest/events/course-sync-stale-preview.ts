export const COURSE_SYNC_STALE_PREVIEW_EVENT = 'course-sync/preview.held'

export type CourseSyncStalePreviewData = {
	bindingId: string
	courseVersionId: string
	controlPlaneRunId: string
	planSha256: string
	heldAt: string
}

export type CourseSyncStalePreviewRequested = {
	name: typeof COURSE_SYNC_STALE_PREVIEW_EVENT
	data: CourseSyncStalePreviewData
}
