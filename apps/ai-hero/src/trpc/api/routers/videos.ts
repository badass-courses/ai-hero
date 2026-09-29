import { getVideoViewerStatus } from '@/lib/video-viewer-status-query'
import { createTRPCRouter, publicProcedure } from '@/trpc/api/trpc'

export const videosRouter = createTRPCRouter({
	/**
	 * The viewer's watched, progress and owned ids for /videos, fetched once
	 * after the static grid renders. Anonymous visitors get the empty status
	 * without a database read; the query always runs because the email-course
	 * `ck_subscriber` cookie is httpOnly and the client cannot see it.
	 */
	viewerStatus: publicProcedure.query(() => getVideoViewerStatus()),
})
