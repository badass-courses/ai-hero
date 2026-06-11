'use client'

import * as React from 'react'
import { useMuxChapters } from '@/components/video-chapters/use-mux-chapters'
import { useMuxMetadata } from '@/hooks/use-mux-metadata'
import {
	type MuxPlayerProps,
	type MuxPlayerRefAttributes,
} from '@mux/mux-player-react'
import MuxPlayer from '@mux/mux-player-react/lazy'

import { type VideoResource } from '@coursebuilder/core/schemas/video-resource'
import { cn } from '@coursebuilder/ui/utils/cn'

export function LessonPlayer({
	muxPlaybackId,
	className,
	videoResource,
	title,
}: {
	muxPlaybackId?: string
	videoResource: VideoResource | null | undefined
	className?: string
	title?: string
}) {
	const muxMetadata = useMuxMetadata({
		videoId: videoResource?.id,
		videoTitle: title || videoResource?.id,
		contentType: 'lesson',
	})

	const playerRef = React.useRef<MuxPlayerRefAttributes>(null)
	const chapters = videoResource?.chapters ?? null
	useMuxChapters(playerRef, chapters)

	const playerProps = {
		id: 'mux-player',
		defaultHiddenCaptions: true,
		streamType: 'on-demand',
		thumbnailTime: 0,
		playbackRates: [0.75, 1, 1.25, 1.5, 1.75, 2],
		maxResolution: '2160p',
		minResolution: '540p',
	} as MuxPlayerProps

	const playbackId = muxPlaybackId || videoResource?.muxPlaybackId

	return (
		<>
			{playbackId ? (
				<MuxPlayer
					ref={playerRef}
					metadata={muxMetadata}
					playbackId={playbackId}
					className={cn(className)}
					{...playerProps}
				/>
			) : null}
		</>
	)
}
