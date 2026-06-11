'use client'

import * as React from 'react'
import Image from 'next/image'

import { cn } from '@coursebuilder/ui/utils/cn'

export function VideoThumbnailPreview({
	thumbnailUrl,
	muxPlaybackId,
	title,
	thumbnailTime = 0,
	quality = 'low',
	className,
}: {
	thumbnailUrl: string
	muxPlaybackId: string
	title?: string
	thumbnailTime?: number
	quality?: 'low' | 'medium' | 'high'
	className?: string
}) {
	const [shouldShowVideo, setShouldShowVideo] = React.useState(false)
	const [isVideoPlaying, setIsVideoPlaying] = React.useState(false)
	const enterTimeoutRef = React.useRef<NodeJS.Timeout | null>(null)
	const leaveTimeoutRef = React.useRef<NodeJS.Timeout | null>(null)

	const handleMouseEnter = React.useCallback(() => {
		if (leaveTimeoutRef.current) {
			clearTimeout(leaveTimeoutRef.current)
			leaveTimeoutRef.current = null
		}
		enterTimeoutRef.current = setTimeout(() => {
			setShouldShowVideo(true)
		}, 300)
	}, [])

	const handleMouseLeave = React.useCallback(() => {
		if (enterTimeoutRef.current) {
			clearTimeout(enterTimeoutRef.current)
			enterTimeoutRef.current = null
		}
		setIsVideoPlaying(false)
		leaveTimeoutRef.current = setTimeout(() => {
			setShouldShowVideo(false)
		}, 500)
	}, [])

	React.useEffect(() => {
		return () => {
			if (enterTimeoutRef.current) clearTimeout(enterTimeoutRef.current)
			if (leaveTimeoutRef.current) clearTimeout(leaveTimeoutRef.current)
		}
	}, [])

	const mp4Src = `https://stream.mux.com/${muxPlaybackId}/${quality}.mp4#t=${thumbnailTime}`

	return (
		<div
			className={cn('relative h-full w-full', className)}
			onMouseEnter={handleMouseEnter}
			onMouseLeave={handleMouseLeave}
		>
			<Image
				loading="lazy"
				src={thumbnailUrl}
				alt={title ?? ''}
				fill
				sizes="(min-width: 768px) 33vw, 100vw"
				className={cn(
					'object-cover transition-opacity duration-300',
					isVideoPlaying ? 'pointer-events-none opacity-0' : 'opacity-100',
				)}
			/>
			{shouldShowVideo && (
				<video
					src={mp4Src}
					poster={thumbnailUrl}
					autoPlay
					muted
					loop
					playsInline
					preload="auto"
					aria-hidden
					onPlaying={() => setIsVideoPlaying(true)}
					className="pointer-events-none absolute inset-0 h-full w-full object-cover"
				/>
			)}
		</div>
	)
}
