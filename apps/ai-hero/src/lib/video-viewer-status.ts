/**
 * One viewer's state on /videos, merged onto the static grid after the page
 * loads: what they finished (✓ and "Hide watched") and which courses they own
 * (which course lessons the grid may show them).
 */
export type VideoViewerStatus = {
	watchedIds: string[]
	/** Courses the viewer bought. Signed-in viewers only. */
	ownedIds: string[]
}

export const EMPTY_VIDEO_VIEWER_STATUS: VideoViewerStatus = {
	watchedIds: [],
	ownedIds: [],
}
