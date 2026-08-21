'use client'

import * as React from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { PlayerPrefToggles } from '@/app/(content)/_components/player-pref-toggles'
import { PlayerGestureShell } from '@/components/player/player-gesture-shell'
import Spinner from '@/components/spinner'
import { useMuxChapters } from '@/components/video-chapters/use-mux-chapters'
import { useMuxMetadata } from '@/hooks/use-mux-metadata'
import { useMuxPlayer } from '@/hooks/use-mux-player'
import {
	handleTextTrackChange,
	setPreferredTextTrack,
} from '@/hooks/use-mux-player-prefs'
import { muxMinResolutionForPrefs } from '@/lib/mux-player-prefs'
import { setProgressForResource } from '@/lib/progress'
import { track } from '@/utils/analytics'
import {
	flattenListResources,
	getNextUpResourceFromList,
} from '@/utils/get-nextup-resource-from-list'
import MuxPlayer, {
	type MuxPlayerProps,
	type MuxPlayerRefAttributes,
} from '@mux/mux-player-react'

import { type VideoResource } from '@coursebuilder/core/schemas/video-resource'
import { useVideoPlayerOverlay } from '@coursebuilder/ui/hooks/use-video-player-overlay'
import { cn } from '@coursebuilder/ui/utils/cn'

import PostNextUpFromListPagination from '../../_components/post-next-up-from-list-pagination'
import { useList } from '../../[post]/_components/list-provider'
import { useProgress } from '../../[post]/_components/progress-provider'

export function PostPlayer({
	muxPlaybackId,
	className,
	videoResource,
	postId,
	thumbnailTime,
	title,
}: {
	muxPlaybackId?: string
	videoResource: VideoResource
	className?: string
	postId: string
	thumbnailTime?: number
	title?: string
}) {
	// const ability = abilityLoader ? use(abilityLoader) : null
	// const canView = ability?.canView
	// const playbackId = muxPlaybackId

	const { dispatch: dispatchVideoPlayerOverlay, state } =
		useVideoPlayerOverlay()
	const { setMuxPlayerRef, setPlayerPrefs, playerPrefs } = useMuxPlayer()
	const { playbackRate, volume, autoplay } = playerPrefs
	const minResolution = muxMinResolutionForPrefs(playerPrefs)
	const muxMetadata = useMuxMetadata({
		videoId: videoResource?.id,
		videoTitle: title || videoResource?.id,
		contentType: 'post',
	})
	const playerRef = React.useRef<MuxPlayerRefAttributes>(null)
	const chapters = videoResource?.chapters ?? null
	useMuxChapters(playerRef, chapters)
	const searchParams = useSearchParams()
	const time = searchParams.get('t')

	const { addLessonProgress: addOptimisticLessonProgress } = useProgress()
	const { list } = useList()
	const nextUp = list && getNextUpResourceFromList(list, postId)
	const router = useRouter()

	React.useEffect(() => {
		setMuxPlayerRef(playerRef)
	}, [playerRef])

	const playerProps = {
		playsInline: true,
		defaultHiddenCaptions: true,
		streamType: 'on-demand',
		forwardSeekOffset: 5,
		backwardSeekOffset: 5,
		thumbnailTime: autoplay ? 0 : thumbnailTime || 0,
		playbackRates: [0.75, 1, 1.25, 1.5, 1.75, 2],
		maxResolution: '2160p',
		minResolution,
		accentColor: '#DD9637',
		currentTime: time ? Number(time) : 0,
		playbackRate,
		onRateChange: (evt: Event) => {
			const target = evt.target as HTMLVideoElement
			const value = target.playbackRate || 1
			setPlayerPrefs({ playbackRate: value })
		},
		volume,
		onVolumeChange: (evt: Event) => {
			const target = evt.target as HTMLVideoElement
			const value = target.volume || 1
			setPlayerPrefs({ volume: value })
		},
		onLoadedData: () => {
			dispatchVideoPlayerOverlay({ type: 'HIDDEN' })
			handleTextTrackChange(playerRef, setPlayerPrefs)
			setPreferredTextTrack(playerRef)

			if (autoplay) {
				playerRef.current?.play().catch(console.warn)
			}
		},
		onEnded: async () => {
			if (autoplay && nextUp) {
				router.push(`/${nextUp?.resource.fields?.slug}`)
			} else {
				dispatchVideoPlayerOverlay({ type: 'COMPLETED', playerRef })
			}
			addOptimisticLessonProgress(postId)
			await setProgressForResource({
				resourceId: postId,
				isCompleted: true,
			})
			await track('video_completed', {
				video_id: videoResource?.id,
				video_title: title || videoResource?.id,
			})
		},
		onPlay: () => {
			dispatchVideoPlayerOverlay({ type: 'HIDDEN' })
		},
	} as MuxPlayerProps

	const playbackId =
		videoResource?.state === 'ready'
			? muxPlaybackId || videoResource?.muxPlaybackId
			: null

	return (
		<div className={cn('relative h-full w-full', className)}>
			{playbackId ? (
				<PlayerGestureShell
					playerRef={playerRef}
					className="h-full w-full"
					chromeSlot={
						<PlayerPrefToggles
							idPrefix="player-chrome"
							className="rounded-[9px] bg-black/60 px-3 py-1.5 text-white"
							toggleClassName="text-white"
						/>
					}
				>
					<MuxPlayer
						metadata={muxMetadata}
						playbackId={playbackId}
						className={cn('h-full w-full', className)}
						ref={playerRef}
						{...playerProps}
					/>
				</PlayerGestureShell>
			) : (
				<div className="flex h-full w-full items-center justify-center bg-gray-300">
					<Spinner />
				</div>
			)}
			{state.action?.type === 'COMPLETED' && (
				<div
					className={cn(
						// z-30 keeps the completed overlay above the gesture layer's
						// z-20 HUD/cluster so end-of-video actions stay tappable.
						'bg-background/85 dark absolute left-0 top-0 z-30 flex h-full w-full flex-col items-center justify-center pb-6 backdrop-blur-md sm:pb-16',
						className,
					)}
				>
					<PostNextUpFromListPagination
						postId={postId}
						className="text-white! mt-0 border-0 bg-transparent px-0 py-0 dark:bg-transparent"
						// The list AND its members (sections descended), same as the
						// finale case in `[post]/page.tsx`: this overlay shows when the
						// reader finished the list's last video, so its own lessons —
						// and its own front door — are the recommendations to exclude.
						// The wrapper rows this used to map have `resourceId`, not `id`,
						// so it excluded nothing (an array of undefined) and skipped
						// section children besides.
						documentIdsToSkip={
							list
								? [
										list.id,
										...flattenListResources(list)
											.map((wrapper) => wrapper.resource?.id)
											.filter(
												(id): id is string => typeof id === 'string',
											),
									]
								: undefined
						}
					/>
				</div>
			)}
		</div>
	)
}

export function SimplePostPlayer({
	ref,
	muxPlaybackId,
	className,
	videoResource,
	handleVideoTimeUpdate,
	thumbnailTime,
}: {
	ref?: React.RefObject<MuxPlayerRefAttributes | null>
	muxPlaybackId?: string
	videoResource: VideoResource
	className?: string
	handleVideoTimeUpdate?: (e: Event) => void
	thumbnailTime?: number
}) {
	const { playerPrefs } = useMuxPlayer()
	const minResolution = muxMinResolutionForPrefs(playerPrefs)
	const muxMetadata = useMuxMetadata({
		videoId: videoResource?.id,
		videoTitle: videoResource?.title ?? undefined,
		contentType: 'post',
	})

	const localRef = React.useRef<MuxPlayerRefAttributes | null>(null)
	const playerRef = ref ?? localRef
	useMuxChapters(playerRef, videoResource?.chapters ?? null)

	const playerProps = {
		id: 'mux-player',
		defaultHiddenCaptions: true,
		streamType: 'on-demand',
		thumbnailTime: thumbnailTime,
		accentColor: '#DD9637',
		playbackRates: [0.75, 1, 1.25, 1.5, 1.75, 2],
		maxResolution: '2160p',
		minResolution,
	} as MuxPlayerProps

	const playbackId =
		videoResource?.state === 'ready'
			? muxPlaybackId || videoResource?.muxPlaybackId
			: null

	return (
		<>
			{playbackId ? (
				<>
					<MuxPlayer
						ref={playerRef}
						metadata={muxMetadata}
						onTimeUpdate={(e) => {
							handleVideoTimeUpdate && handleVideoTimeUpdate(e)
						}}
						playbackId={playbackId}
						className={cn(className)}
						{...playerProps}
					/>
				</>
			) : (
				<div className="flex h-full w-full items-center justify-center bg-gray-300">
					<Spinner />
				</div>
			)}
		</>
	)
}
