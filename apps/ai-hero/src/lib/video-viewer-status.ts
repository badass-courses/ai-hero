import type { VideoPlayback } from './video-facts'

/**
 * A signed-in viewer's state on /videos, merged onto the static grid after the
 * page loads: what they finished (✓ and "Hide watched"), which courses they
 * own (which lessons the grid may show them), and the playback of the paid
 * lessons among those, which the public index withholds.
 */
export type VideoViewerStatus = {
	watchedIds: string[]
	ownedIds: string[]
	playback: Record<string, VideoPlayback>
}

export const EMPTY_VIDEO_VIEWER_STATUS: VideoViewerStatus = {
	watchedIds: [],
	ownedIds: [],
	playback: {},
}
