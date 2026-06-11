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
 * Use this instead of raw `MuxPlayer` anywhere you want analytics tracking.
 */
export function TrackedMuxPlayer({
	contentType = 'marketing',
	...props
}: MuxPlayerProps & { contentType?: string }) {
	const metadata = useMuxMetadata({
		videoId: props.playbackId,
		videoTitle: props.title,
		contentType,
	})

	return <MuxPlayer metadata={metadata} {...props} />
}
