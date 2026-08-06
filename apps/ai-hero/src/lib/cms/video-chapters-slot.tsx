import { VideoChaptersEditor } from '@/components/video-chapters/video-chapters-editor'

import type { MediaSpec, VideoDetail } from '@coursebuilder/ui/cms'

/**
 * Chapters editing for the Media tab's video preview dialog.
 *
 * Chapters belong to the videoResource, not to whatever resource happens to
 * be open — so this is wired into EVERY editor with a Media tab, not just the
 * post/lesson/solution editors that also expose chapters on their Video tab
 * (via `CmsVideoField`'s children slot). Opening any video in the library is
 * enough to chapter it.
 *
 * The kit stays chapter-agnostic: `MediaSpec.videoDetailSlot` is a generic
 * per-video escape hatch (the `videoSlot` pattern, scoped to one video), and
 * `VideoChaptersEditor` owns its own persistence via
 * `api.videoResources.updateChapters` — the preview dialog is not a form and
 * never saves on its behalf.
 */
export function withVideoChapters(media: MediaSpec | undefined) {
	// Undefined means the type has no Media tab at all; don't conjure one.
	if (!media) return media
	return {
		...media,
		videoDetailSlot: (detail: VideoDetail) => (
			<VideoChaptersEditor
				videoResourceId={detail.id}
				initialChapters={detail.chapters}
				videoDuration={detail.duration}
			/>
		),
	} satisfies MediaSpec
}
