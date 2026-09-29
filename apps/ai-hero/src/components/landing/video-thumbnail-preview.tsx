'use client'

import * as React from 'react'
import Image from 'next/image'
import type { MuxPlayerRefAttributes } from '@mux/mux-player-react'
import MuxPlayer from '@mux/mux-player-react/lazy'

import { cn } from '@coursebuilder/ui/utils/cn'

export function VideoThumbnailPreview({
	thumbnailUrl,
	muxPlaybackId,
	title,
	thumbnailTime = 0,
	quality = 'low',
	inline = false,
	active,
	sound = false,
	captions = false,
	resumeAt,
	onTimeChange,
	className,
}: {
	thumbnailUrl: string
	muxPlaybackId: string
	title?: string
	thumbnailTime?: number
	quality?: 'low' | 'medium' | 'high'
	/**
	 * YouTube-style inline playback: the HLS stream (which carries the video's
	 * Mux subtitles), sound and captions as the viewer set them, and a progress
	 * bar. Without it the preview is a silent low-res mp4 loop.
	 */
	inline?: boolean
	/**
	 * Hover owned by the parent — for a card whose controls sit outside this
	 * element, so moving onto them does not count as leaving. Left undefined,
	 * the preview tracks the pointer itself.
	 */
	active?: boolean
	/**
	 * Inline only. Hovering is not a user gesture, so until the viewer has
	 * clicked somewhere on the page the browser refuses audio and the preview
	 * falls back to muted.
	 */
	sound?: boolean
	/** Inline only. */
	captions?: boolean
	/** Inline only: where to pick up, instead of `thumbnailTime`. */
	resumeAt?: number
	/** Inline only: the playhead, in seconds, as the preview plays. */
	onTimeChange?: (seconds: number) => void
	className?: string
}) {
	const [hovered, setHovered] = React.useState(false)
	const isActive = active ?? hovered
	const [shouldShowVideo, setShouldShowVideo] = React.useState(false)
	const [isVideoPlaying, setIsVideoPlaying] = React.useState(false)
	const [progress, setProgress] = React.useState(0)
	const playerRef = React.useRef<MuxPlayerRefAttributes | null>(null)

	React.useEffect(() => {
		if (isActive) {
			// Back within the fade-out: the player is still mounted, just paused.
			playerRef.current?.play()?.catch(() => {})
			const timeout = setTimeout(() => setShouldShowVideo(true), 300)
			return () => clearTimeout(timeout)
		}
		setIsVideoPlaying(false)
		// Stop at once: the player lingers for the fade-out below, and a preview
		// with sound should not talk over the next card's.
		playerRef.current?.pause()
		const timeout = setTimeout(() => {
			setShouldShowVideo(false)
			setProgress(0)
		}, 500)
		return () => clearTimeout(timeout)
	}, [isActive])

	// `defaultHiddenCaptions` only applies on load; a CC toggle mid-preview
	// flips the subtitle track directly.
	React.useEffect(() => {
		const tracks = playerRef.current?.textTracks
		if (!inline || !isVideoPlaying || !tracks) return
		for (const track of Array.from(tracks)) {
			if (track.kind === 'subtitles' || track.kind === 'captions') {
				track.mode = captions ? 'showing' : 'disabled'
			}
		}
	}, [inline, captions, isVideoPlaying])

	const mp4Src = `https://stream.mux.com/${muxPlaybackId}/${quality}.mp4#t=${thumbnailTime}`

	return (
		<div
			className={cn('relative h-full w-full', className)}
			onMouseEnter={active === undefined ? () => setHovered(true) : undefined}
			onMouseLeave={active === undefined ? () => setHovered(false) : undefined}
		>
			<Image
				loading="lazy"
				src={thumbnailUrl}
				alt={title ?? ''}
				fill
				sizes="(min-width: 768px) 33vw, 100vw"
				className={cn(
					'object-cover transition-opacity duration-300',
					// Inline playback fades the player in over the still instead, so
					// the thumbnail never gives way to an empty box while it loads.
					isVideoPlaying && !inline
						? 'pointer-events-none opacity-0'
						: 'opacity-100',
				)}
			/>
			{shouldShowVideo && inline ? (
				<>
					<MuxPlayer
						ref={playerRef}
						playbackId={muxPlaybackId}
						streamType="on-demand"
						// 'any' tries with sound, then muted if the browser refuses.
						autoPlay={sound ? 'any' : 'muted'}
						muted={!sound}
						loop
						playsInline
						startTime={resumeAt ?? thumbnailTime}
						maxResolution="720p"
						defaultHiddenCaptions={!captions}
						// Hover previews are not views; keep them out of Mux Data.
						disableTracking
						nohotkeys
						poster={thumbnailUrl}
						aria-hidden
						onPlaying={() => setIsVideoPlaying(true)}
						onTimeUpdate={(event) => {
							const media = event.target as HTMLMediaElement
							if (media.duration > 0) {
								setProgress(media.currentTime / media.duration)
							}
							onTimeChange?.(media.currentTime)
						}}
						// Invisible until frames are painting; the still sits underneath.
						className={cn(
							'pointer-events-none absolute inset-0 h-full w-full transition-opacity duration-300',
							isVideoPlaying ? 'opacity-100' : 'opacity-0',
						)}
						style={{
							'--controls': 'none',
							'--media-object-fit': 'cover',
							'--media-background-color': 'transparent',
							aspectRatio: 'auto',
						}}
					/>
					{isVideoPlaying && (
						<span
							aria-hidden
							className="bg-foreground/25 pointer-events-none absolute inset-x-0 bottom-0 h-[3px]"
						>
							<span
								className="bg-primary block h-full"
								style={{ width: `${progress * 100}%` }}
							/>
						</span>
					)}
				</>
			) : shouldShowVideo ? (
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
			) : null}
		</div>
	)
}
