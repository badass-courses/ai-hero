'use client'

import * as React from 'react'
import Image from 'next/image'
import { PlayerGestureShell } from '@/components/player/player-gesture-shell'
import { useMuxMetadata } from '@/hooks/use-mux-metadata'
import { useMuxPlayer } from '@/hooks/use-mux-player'
import { useVideoQualityPref } from '@/hooks/use-video-quality-pref'
import { muxMinResolutionForPrefs } from '@/lib/mux-player-prefs'
import { api } from '@/trpc/react'
import type {
	MuxPlayerProps,
	MuxPlayerRefAttributes,
} from '@mux/mux-player-react'
import MuxPlayer from '@mux/mux-player-react'

import { cn } from '@coursebuilder/ui/utils/cn'

import Spinner from '../spinner'

export default function MDXVideo({
	resourceId,
	muxPlaybackId,
	thumbnailTime = 0,
	poster,
	className,
	props,
}: {
	resourceId: string
	/**
	 * Playback ID resolved server-side (free MDX embeds). When provided, the
	 * gated `videoResources.get` query is skipped — see the `Video` mapping in
	 * `compile-mdx.tsx`. Callers that only pass `resourceId` (e.g. the admin page
	 * builder) keep falling back to the query.
	 */
	muxPlaybackId?: string
	thumbnailTime?: number
	poster?: string
	className?: string
	props?: MuxPlayerProps
}) {
	const { playerPrefs } = useMuxPlayer()
	const minResolution = muxMinResolutionForPrefs(playerPrefs)
	const { data, status } = api.videoResources.get.useQuery(
		{ videoResourceId: resourceId },
		{ enabled: !muxPlaybackId },
	)
	const muxMetadata = useMuxMetadata({
		videoId: resourceId,
		videoTitle: resourceId,
		contentType: 'mdx-embed',
	})

	const playbackId = muxPlaybackId ?? data?.muxPlaybackId
	const playerRef = React.useRef<MuxPlayerRefAttributes>(null)
	const bindVideoQuality = useVideoQualityPref(playerRef)

	// Only show the loading state while the fallback query is actually running.
	if (!muxPlaybackId && status === 'pending')
		return (
			<div
				className={cn(
					'not-prose relative mb-5 flex aspect-video w-full max-w-4xl items-center justify-center overflow-hidden rounded-lg border',
					className,
				)}
			>
				<Spinner className="relative z-10 h-6 w-6" />
				{poster && (
					<Image
						src={poster}
						alt={''}
						aria-hidden="true"
						fill
						className="object-fill opacity-25"
					/>
				)}
			</div>
		)

	if (!playbackId) return null

	return (
		<PlayerGestureShell
			playerRef={playerRef}
			className={cn(
				'not-prose mb-5 aspect-video w-full max-w-4xl overflow-hidden rounded-lg border',
				className,
			)}
		>
			<MuxPlayer
				ref={playerRef}
				metadata={muxMetadata}
				streamType="on-demand"
				className="h-full w-full"
				forwardSeekOffset={5}
				backwardSeekOffset={5}
				playbackRates={[0.75, 1, 1.25, 1.5, 1.75, 2]}
				maxResolution="2160p"
				minResolution={minResolution}
				accentColor="#DD9637"
				playbackId={playbackId}
				thumbnailTime={thumbnailTime}
				poster={poster}
				playsInline
				{...props}
				onLoadedMetadata={(event) => {
					bindVideoQuality()
					props?.onLoadedMetadata?.(event)
				}}
			/>
		</PlayerGestureShell>
	)
}
