'use client'

import * as React from 'react'
import Image from 'next/image'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { EyeIcon } from '@heroicons/react/24/outline'
import { Subtitles, Volume2, VolumeX } from 'lucide-react'

import { cn } from '@coursebuilder/ui/utils/cn'

import { BADGE_OUTLINE, TYPE } from './type'
import { useVideoPreviewPrefs } from './video-preview-prefs'
import { VideoThumbnailPreview } from './video-thumbnail-preview'

export function ResourceCard({
	title,
	href,
	image,
	muxPlaybackId,
	thumbnailTime,
	formatLabel,
	badges,
	overlay,
	meta,
	inlinePlayback = false,
}: {
	title: string
	href: string
	image?: string
	muxPlaybackId?: string
	thumbnailTime?: number
	/** "Video · 12 min", "Video", or "Article". Built by `buildFormatLabel`. */
	formatLabel?: string
	/** Replaces the format label with a row of badges (e.g. /videos access). */
	badges?: React.ReactNode
	/** Laid over the thumbnail, above the hover preview: runtimes, status. */
	overlay?: React.ReactNode
	/** A line under the title. */
	meta?: React.ReactNode
	/**
	 * YouTube-style hover playback: captions, a progress bar, and sound and CC
	 * buttons on the thumbnail whose choice every card shares. Without it the
	 * hover preview is a silent loop.
	 */
	inlinePlayback?: boolean
}) {
	const isExternal = /^https?:\/\//i.test(href)
	const hasPreview = Boolean(muxPlaybackId && image)
	const [prefs, setPrefs] = useVideoPreviewPrefs()
	// Hover lives on the wrapper, not the thumbnail, so reaching for the sound
	// button (a sibling of the link, not inside it) does not stop the preview.
	const [hovered, setHovered] = React.useState(false)
	const inline = inlinePlayback && hasPreview
	// Where the preview got to: the next hover continues from it, and a click
	// opens the video there, like YouTube.
	const previewPosition = React.useRef<number | null>(null)
	const [resumeAt, setResumeAt] = React.useState<number | undefined>()
	const router = useRouter()

	const openAtPreviewPosition = (event: React.MouseEvent) => {
		const seconds = previewPosition.current
		const watched = seconds !== null && seconds - (thumbnailTime ?? 0) >= 3
		// Without a real look at the preview, let the page choose (a lesson
		// resumes from its saved position; `t` would override that).
		if (!watched || event.button !== 0) return
		if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
		event.preventDefault()
		router.push(withStartTime(href, seconds))
	}

	const link = (
		<Link
			href={href}
			prefetch={!isExternal}
			target={isExternal ? '_blank' : undefined}
			rel={isExternal ? 'noopener noreferrer' : undefined}
			onClick={inline && !isExternal ? openAtPreviewPosition : undefined}
			className="group flex h-full flex-col"
		>
			<div
				className={cn(
					// clip-path, not just overflow + radius: a playing video is its own
					// compositing layer and escapes a rounded overflow clip.
					'relative aspect-video w-full overflow-hidden rounded-[10px] [clip-path:inset(0_round_10px)]',
					image ? 'bg-muted' : 'bg-stripes',
				)}
			>
				{muxPlaybackId && image ? (
					<VideoThumbnailPreview
						thumbnailUrl={image}
						muxPlaybackId={muxPlaybackId}
						title={title}
						thumbnailTime={thumbnailTime}
						{...(inline && {
							inline: true,
							active: hovered,
							sound: prefs.sound,
							captions: prefs.captions,
							resumeAt,
							onTimeChange: (seconds: number) => {
								previewPosition.current = seconds
							},
						})}
					/>
				) : image ? (
					<Image
						src={image}
						alt={title}
						fill
						className="object-cover transition-transform duration-300 group-hover:scale-[1.02]"
						sizes="(min-width: 768px) 33vw, 100vw"
					/>
				) : (
					<span className="absolute inset-0 flex items-center justify-center font-mono text-4xl font-semibold uppercase tracking-widest">
						<EyeIcon className="size-10 text-neutral-400 dark:text-neutral-500" />
					</span>
				)}
				{overlay}
			</div>
			<div className="flex flex-col items-start gap-[9px] pt-[13px]">
				{badges ??
					(formatLabel ? (
						<span className={cn(TYPE.badge, BADGE_OUTLINE, 'inline-flex w-fit')}>
							{formatLabel}
						</span>
					) : null)}
				<h3
					className={cn(
						TYPE.bodyTight,
						'group-hover:text-primary text-balance tracking-[-0.012em] transition-colors',
					)}
				>
					{title}
				</h3>
				{meta}
			</div>
		</Link>
	)

	if (!inline) return link

	return (
		<div
			className="group/card relative h-full"
			onMouseEnter={() => setHovered(true)}
			onMouseLeave={() => {
				setHovered(false)
				if (previewPosition.current !== null) {
					setResumeAt(previewPosition.current)
				}
			}}
		>
			{link}
			<div className="absolute right-2.5 top-2.5 flex gap-1.5 opacity-0 transition-opacity duration-300 focus-within:opacity-100 group-hover/card:opacity-100">
				<PreviewToggle
					pressed={prefs.sound}
					onToggle={() => setPrefs({ sound: !prefs.sound })}
					label={prefs.sound ? 'Mute previews' : 'Unmute previews'}
				>
					{prefs.sound ? <Volume2 /> : <VolumeX />}
				</PreviewToggle>
				<PreviewToggle
					pressed={prefs.captions}
					onToggle={() => setPrefs({ captions: !prefs.captions })}
					label={
						prefs.captions
							? 'Hide captions in previews'
							: 'Show captions in previews'
					}
				>
					<Subtitles />
				</PreviewToggle>
			</div>
		</div>
	)
}

/** Both video players read `?t=<seconds>` as the start time. */
function withStartTime(href: string, seconds: number) {
	return `${href}${href.includes('?') ? '&' : '?'}t=${Math.floor(seconds)}`
}

function PreviewToggle({
	pressed,
	onToggle,
	label,
	children,
}: {
	pressed: boolean
	onToggle: () => void
	label: string
	children: React.ReactNode
}) {
	return (
		<button
			type="button"
			aria-pressed={pressed}
			aria-label={label}
			title={label}
			onClick={onToggle}
			className={cn(
				'focus-visible:ring-ring inline-flex size-8 items-center justify-center rounded-full backdrop-blur-sm transition-colors focus-visible:outline-none focus-visible:ring-2 [&_svg]:size-4',
				// On reads as filled, like YouTube's CC button.
				pressed
					? 'bg-foreground text-background'
					: 'bg-background/80 text-foreground hover:bg-background',
			)}
		>
			{children}
		</button>
	)
}
