'use client'

import { useMuxMetadata } from '@/hooks/use-mux-metadata'
import type { MuxPlayerProps } from '@mux/mux-player-react'
import MuxPlayer from '@mux/mux-player-react'

/**
 * MuxPlayer wrapper that automatically injects Mux Data metadata.
 *
 * Drop-in replacement for raw MuxPlayer in MDX components and marketing pages.
 * Passes viewer_user_id (if logged in), content type, and viewer_plan.
 *
 * Use this instead of raw `MuxPlayer` anywhere you want analytics tracking —
 * and pass `videoResourceId` so the view is keyed like every other player:
 * Mux Data `video_id` = the videoResource id (the key `useMuxMetadata`
 * standardizes and the cms analytics strip filters on). Historically this
 * component sent the playbackId as `video_id` — those rows are orphaned by
 * design (negligible traffic; accepted discontinuity). When the caller
 * genuinely has no videoResource (e.g. hand-authored MDX with a bare
 * playbackId), `video_id` is simply omitted rather than mis-keyed.
 */
export function TrackedMuxPlayer({
	contentType = 'marketing',
	videoResourceId,
	...props
}: MuxPlayerProps & { contentType?: string; videoResourceId?: string }) {
	const metadata = useMuxMetadata({
		videoId: videoResourceId,
		videoTitle: props.title,
		contentType,
	})

	return <MuxPlayer metadata={metadata} {...props} />
}
