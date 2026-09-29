import { getVideoViewerStatus } from '@/lib/video-viewer-status-query'
import { createTRPCRouter, publicProcedure } from '@/trpc/api/trpc'

export const videosRouter = createTRPCRouter({
	/**
	 * The viewer's state for /videos, fetched once after the static grid
	 * renders: watched ids for signed-in and Kit-verified email-course viewers;
	 * owned courses and their paid lessons' playback for signed-in ones only.
	 * Anonymous visitors get the empty status without a database read.
	 */
	viewerStatus: publicProcedure.query(() => getVideoViewerStatus()),
})
