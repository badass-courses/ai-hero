'use client'

import * as React from 'react'
import Image from 'next/image'
import { PlayerContainerSkeleton } from '@/components/player-skeleton'

import type {
	ContentResource,
	VideoChapter,
} from '@coursebuilder/core/schemas'
import { VideoPlayerOverlayProvider } from '@coursebuilder/ui/hooks/use-video-player-overlay'

import { AuthedVideoPlayer } from './authed-video-player'
import VideoPlayerOverlay from './video-player-overlay'

/** What a lesson page hands the player, after its own access check. */
export type LessonVideo = {
	resource: ContentResource
	muxPlaybackId: string
	chapters: VideoChapter[] | null
	/** The server's saved position on this request, in seconds. */
	savedPosition: number | null
	moduleSlug: string
	/** Blurred behind the skeleton before the player hydrates. */
	thumbnailUrl: string | null
}

type HostContext = {
	register: (video: LessonVideo | null) => void
	/** A page has registered, so the host draws the player (or nothing). */
	registered: boolean
}

const LessonPlayerHostContext = React.createContext<HostContext | null>(null)

// Positions written in this tab, by resource id. The router cache can replay
// a page with the saved position from its first visit; back/forward resumes
// from here instead. Module scope, so leaving the lessons for the workshop
// page and coming back keeps it. Only written from media events, so the
// server's copy stays empty.
// It also wins over a server position that is newer: watch further on a phone,
// come back to this tab, and the lesson resumes where this tab left it. The
// page payload carries no timestamp to tell a fresh read from a replay, and
// resuming where this screen stopped is a fair answer, so that is accepted.
const sessionPositions = new Map<string, number>()

// The box the player and its skeleton share, so neither shifts the page.
// The width cap mirrors the height cap: with only max-h, a short viewport
// clamps the height while the width stays full, the box stops being 16:9,
// and Safari/Chrome each mangle the mismatch (cropped video, cut-off
// controls). Height-capped + width-capped keeps it a 16:9 that always fits.
const PLAYER_BOX =
	'aspect-video h-auto w-full max-w-full overflow-hidden md:max-h-[75svh] md:max-w-[calc(75svh*16/9)]'

function VideoSection({ children }: { children: React.ReactNode }) {
	return (
		<section
			aria-label="video"
			className="dark relative flex flex-col items-center justify-center border-b bg-black text-white dark:text-white"
		>
			{children}
		</section>
	)
}

/**
 * The lesson player, owned by the `(learn)` layout so it outlives lesson
 * changes: the same `<mux-player>` and fullscreen element play every lesson,
 * and only the source swaps. Fullscreen and autoplay's play permission
 * therefore survive Continue and the autoplay countdown.
 *
 * It fetches nothing. Each lesson page registers its video (or `null`) through
 * `LessonVideoSource` once it has passed its access check, and the last
 * registration wins. Everything it holds is a plain value: suspending here
 * would hide the playing player behind a fallback.
 */
export function LessonPlayerHost({ children }: { children: React.ReactNode }) {
	// undefined until the first page registers.
	const [video, setVideo] = React.useState<LessonVideo | null | undefined>()
	const context = React.useMemo(
		() => ({ register: setVideo, registered: video !== undefined }),
		[video],
	)

	return (
		<LessonPlayerHostContext value={context}>
			{video && (
				<VideoPlayerOverlayProvider>
					<VideoSection>
						<AuthedVideoPlayer
							className={PLAYER_BOX}
							muxPlaybackId={video.muxPlaybackId}
							resource={video.resource}
							videoChapters={video.chapters}
							savedPosition={video.savedPosition}
							sessionPositions={sessionPositions}
							moduleSlug={video.moduleSlug}
							moduleType="workshop"
							title={video.resource.fields?.title}
							// Inside the player so the end card survives fullscreen.
							// Pages redirect denied viewers before registering, so the
							// card only ever shows completion.
							overlay={
								<VideoPlayerOverlay
									resource={video.resource}
									moduleType="workshop"
									moduleSlug={video.moduleSlug}
								/>
							}
						/>
					</VideoSection>
				</VideoPlayerOverlayProvider>
			)}
			{children}
		</LessonPlayerHostContext>
	)
}

/**
 * Registers this page's video with the host. Render it at the top level of
 * the page, outside any Suspense boundary: a registration that resolved later
 * would leave the previous lesson playing over this one.
 *
 * It never clears on unmount. Lesson → lesson swaps both pages in one commit,
 * so clearing would only flash an empty player; a page without a video
 * registers `null` instead.
 */
export function LessonVideoSource({ video }: { video: LessonVideo | null }) {
	const host = React.use(LessonPlayerHostContext)
	if (!host) throw new Error('LessonVideoSource must be inside LessonPlayerHost')
	const { register, registered } = host

	React.useLayoutEffect(() => {
		register(video)
	}, [register, video])

	// Before hydration the host has nothing yet; hold the player's place where
	// the host will draw it (directly above this page), so the server HTML has
	// the box and nothing shifts. Gone in the commit that registers.
	if (registered || !video) return null
	return (
		<VideoSection>
			{video.thumbnailUrl && (
				<Image
					src={video.thumbnailUrl}
					alt=""
					fill
					className="blur-xs absolute inset-0 z-0 h-full w-full object-cover opacity-20"
					priority
				/>
			)}
			<PlayerContainerSkeleton className="z-10 h-auto w-full bg-transparent md:max-h-[75svh] md:max-w-[calc(75svh*16/9)]" />
		</VideoSection>
	)
}
