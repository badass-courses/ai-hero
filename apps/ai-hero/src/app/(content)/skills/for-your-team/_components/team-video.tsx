'use client'

import * as React from 'react'
import { TYPE } from '@/components/landing/type'
import { useMuxMetadata } from '@/hooks/use-mux-metadata'
import { track } from '@/utils/analytics'
import MuxPlayer from '@mux/mux-player-react'
import { X } from 'lucide-react'

import { cn } from '@coursebuilder/utils/cn'

/**
 * The page's player, plus the ask that appears when the video finishes.
 *
 * ## Why this is not the app's `VideoPlayerOverlayProvider`
 *
 * That system exists for lessons: its `COMPLETED` action carries a
 * `nextResource`, and the overlays it drives are "up next", "module complete"
 * and progress tracking. None of that applies to a single marketing video on a
 * standalone page, and adopting it would mean mounting a provider, a reducer
 * and a switch to represent one boolean.
 *
 * So this owns one piece of state — has the video ended — and nothing else.
 * Scoped to this page on purpose.
 *
 * ## Why the overlay is dismissible
 *
 * Because it covers something the reader might not be finished with. Someone
 * watching with their team will want the last frame, or to scrub back to a
 * point they want to discuss, and an ask they cannot get out of turns the end
 * of the video into a wall. The X restores the player exactly as it was, and
 * pressing play does the same, so the ask never has to be argued with twice.
 *
 * The ask itself is passed in as `children` from the server, which is what
 * keeps the live/waitlist decision (and its database read) out of the client.
 */
export function TeamVideo({
	playbackId,
	title,
	thumbnailTime = 0,
	heading,
	children,
}: {
	playbackId: string
	title: string
	thumbnailTime?: number
	/**
	 * The line above the ask. Authored on the `<Video>` tag in the CMS body, so
	 * the one piece of marketing copy on this overlay is not buried in a
	 * component. It has to NAME the thing: this is the first and only mention of
	 * the crash course a reader gets without scrolling, and a heading that only
	 * gestures at "the whole thing" asks for an email in exchange for a mystery.
	 */
	heading: string
	children: React.ReactNode
}) {
	// Mux serves stills straight off the playback id, so the poster costs no
	// upload and no CMS field: `thumbnailTime` is already authored on the
	// `<Video>` tag in the body, and it picks the frame for both of these.
	//
	// Two sizes, doing two different jobs. The 32px one is the blur-up layer,
	// small enough (~1kB) to arrive with the page rather than after it. The full
	// one is the player's own poster, which replaces it once Mux is ready.
	const stillUrl = (width?: number) =>
		`https://image.mux.com/${playbackId}/thumbnail.webp?time=${thumbnailTime}${
			width ? `&width=${width}` : ''
		}`

	const [hasEnded, setHasEnded] = React.useState(false)
	const [dismissed, setDismissed] = React.useState(false)
	const metadata = useMuxMetadata({
		videoId: playbackId,
		videoTitle: title,
		contentType: 'team-page',
	})

	const showOverlay = hasEnded && !dismissed

	return (
		<div className="relative w-full">
			{/* `aspect-video` on this WRAPPER, not on the player.

			    The player is a custom element, and until its definition loads the
			    browser treats `<mux-player>` as an unknown inline element — an
			    `aspect-ratio` on it does nothing, so the box collapsed to zero
			    height and everything below the video jumped down the page when it
			    upgraded. A plain div holds the 16:9 from first paint and the
			    player fills it absolutely, so nothing on the route can move. */}
			<div className="bg-muted relative aspect-video w-full overflow-hidden">
				{/* The blur-up. Inline background rather than next/image because
				    this has to paint from the server-rendered HTML, before
				    hydration — the exact window the reserved box would otherwise
				    be empty. Scaled past the edges so the blur has nothing to
				    feather against. */}
				<div
					aria-hidden
					className="absolute inset-0 scale-110 bg-cover bg-center blur-2xl"
					style={{ backgroundImage: `url("${stillUrl(32)}")` }}
				/>
				<MuxPlayer
					metadata={metadata}
					streamType="on-demand"
					poster={stillUrl()}
					playbackRates={[0.75, 1, 1.25, 1.5, 1.75, 2]}
					maxResolution="2160p"
					minResolution="540p"
					accentColor="#DD9637"
					playbackId={playbackId}
					thumbnailTime={thumbnailTime}
					playsInline
					// Mux draws its control bar inside the player, so while the
					// overlay sits on top of it the two collide — the scrubber was
					// landing across the submit button. `--controls: none` is the
					// player's own switch. Only above `desk:`, because below it the
					// overlay no longer covers the video and the reader may well
					// want to scrub back.
					className={cn(
						'absolute inset-0 h-full w-full',
						showOverlay && 'desk:[--controls:none]',
					)}
					onEnded={() => {
						setHasEnded(true)
						track('video_completed', { location: 'skills_for_your_team' })
					}}
					// Scrubbing back and playing on is the same signal as the X: this
					// reader is not done with the video. Resetting `dismissed` too
					// means a second genuine finish shows the ask again.
					onPlay={() => {
						setHasEnded(false)
						setDismissed(false)
					}}
				/>
			</div>

			{showOverlay && (
				<div
					// BELOW `desk:` this is not an overlay at all — it is the next
					// block on the page.
					//
					// 16:9 at 390px is a 219px letterbox, and the ask is roughly
					// twice that tall, so overlaying it meant scrolling a form inside
					// a slot the size of a banner: the heading was off-screen before
					// the reader reached the first field. In flow it takes the height
					// it needs, and the video stays visible above it.
					//
					// `desk:` is the spec's one structural breakpoint (DESIGN rule
					// 19), which is exactly what this is: a layout that changes shape
					// rather than a size that changes value.
					//
					// `z-30` because Mux's own control bar paints above `z-10` and was
					// landing on top of the submit button.
					className="bg-background animate-in fade-in relative z-30 px-[18px] pb-10 pt-14 duration-300 ease-out motion-reduce:animate-none desk:absolute desk:inset-0 desk:flex desk:items-center desk:justify-center desk:bg-background/95 desk:p-8 desk:backdrop-blur-sm"
				>
					<button
						type="button"
						onClick={() => setDismissed(true)}
						className="border-input text-foreground/70 hover:text-foreground hover:bg-foreground/5 focus-visible:ring-ring absolute right-3 top-3 inline-flex h-9 w-9 items-center justify-center rounded-sm border transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
					>
						<X className="h-4 w-4" aria-hidden />
						<span className="sr-only">Close and go back to the video</span>
					</button>

					<div className="flex w-full max-w-xl flex-col items-center gap-4 text-center">
						<p className={cn(TYPE.subhead, 'text-balance font-sans')}>
							{heading}
						</p>
						{children}
					</div>
				</div>
			)}
		</div>
	)
}
