'use client'

import { useMemo } from 'react'
import { useSession } from 'next-auth/react'

/**
 * Builds enriched Mux Data metadata for the player.
 *
 * Adds viewer_user_id, video_series, sub_property_id, and viewer_plan
 * so Mux Data can break down by user, series, content type, and plan.
 *
 * @param opts.videoId - The video resource ID
 * @param opts.videoTitle - The video title
 * @param opts.videoSeries - Workshop/tutorial/list name (optional)
 * @param opts.contentType - Content type: post, lesson, exercise, solution, etc.
 *
 * @example
 * ```tsx
 * const metadata = useMuxMetadata({
 *   videoId: resource.id,
 *   videoTitle: 'My Video',
 *   videoSeries: 'My Workshop',
 *   contentType: 'lesson',
 * })
 * <MuxPlayer metadata={metadata} ... />
 * ```
 */
export function useMuxMetadata({
	videoId,
	videoTitle,
	videoSeries,
	contentType,
}: {
	videoId?: string
	videoTitle?: string
	videoSeries?: string
	contentType?: string
}) {
	const { data: session } = useSession()
	const userId = session?.user?.id
	const role = session?.user?.role

	return useMemo(
		() => ({
			video_id: videoId,
			video_title: videoTitle,
			...(userId && { viewer_user_id: userId }),
			...(videoSeries && { video_series: videoSeries }),
			...(contentType && { sub_property_id: contentType }),
			...(role && { viewer_plan: role }),
		}),
		[videoId, videoTitle, userId, videoSeries, contentType, role],
	)
}
