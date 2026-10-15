'use client'

import * as React from 'react'
import { use } from 'react'
import { flushSync, preload } from 'react-dom'
import { useRouter, useSearchParams } from 'next/navigation'
import { PrefetchKind } from 'next/dist/client/components/router-reducer/router-reducer-types'
import { PlayerGestureShell } from '@/components/player/player-gesture-shell'
import { ResumeChip } from '@/components/player/resume-chip'
import { useMuxChapters } from '@/components/video-chapters/use-mux-chapters'
import { useMuxMetadata } from '@/hooks/use-mux-metadata'
import { useMuxPlayer } from '@/hooks/use-mux-player'
import { useVideoQualityPref } from '@/hooks/use-video-quality-pref'
import {
	handleTextTrackChange,
	setPreferredPlaybackRate,
	setPreferredTextTrack,
} from '@/hooks/use-mux-player-prefs'
import {
	findParentLessonForSolution,
	getModuleCompletionState,
	type ResourceNavigation,
} from '@/lib/content-navigation'
import { muxMinResolutionForPrefs } from '@/lib/mux-player-prefs'
import {
	createPlaybackPositionSaveQueue,
	getResumeStartTime,
	normalizePlaybackPosition,
} from '@/lib/playback-position'
import { api } from '@/trpc/react'
import { track } from '@/utils/analytics'
import { getAdjacentWorkshopResources } from '@/utils/get-adjacent-workshop-resources'
import type { AbilityForResource } from '@/utils/get-current-ability-rules'
import MuxPlayer, {
	type MuxPlayerProps,
	type MuxPlayerRefAttributes,
} from '@mux/mux-player-react'
import { useSession } from 'next-auth/react'

import type {
	ContentResource,
	ContentResourceResource,
	ModuleProgress,
	VideoChapter,
} from '@coursebuilder/core/schemas'
import {
	useVideoPlayerOverlay,
	type CompletedAction,
	type VideoPlayerOverlayAction,
} from '@coursebuilder/ui/hooks/use-video-player-overlay'
import { cn } from '@coursebuilder/ui/utils/cn'

import { useWorkshopNavigation } from '../workshops/_components/workshop-navigation-provider'
import { playFromLink } from './play-from-link'
import { AutoPlayToggle } from './autoplay-toggle'
import { completeLessonInBackground } from './complete-lesson-in-background'
import type { EndCardAction } from './end-card'
import { useModuleProgress } from './module-progress-provider'
import { getArrivalPosterUrl, getNextLesson } from './next-lesson'

export function AuthedVideoPlayer({
	title,
	muxPlaybackId,
	className,
	playbackIdLoader,
	playbackPositionLoader,
	abilityLoader,
	resource,
	videoChapters,
	moduleSlug,
	moduleType,
	overlay,
	...props
}: {
	muxPlaybackId?: string
	title?: string
	playbackIdLoader?: Promise<string | null | undefined>
	playbackPositionLoader?: Promise<number | null>
	className?: string
	abilityLoader?: Promise<
		Omit<AbilityForResource, 'canView'> & {
			canViewWorkshop: boolean
			canViewLesson: boolean
			isPendingOpenAccess: boolean
		}
	>
	resource: ContentResource
	videoChapters?: VideoChapter[] | null
	moduleSlug?: string
	moduleType?: 'workshop' | 'tutorial'
	/** Drawn over the video inside the fullscreen element (the end card). */
	overlay?: React.ReactNode
} & MuxPlayerProps) {
	const ability = abilityLoader ? use(abilityLoader) : null
	const canView = ability?.canViewLesson
	const { data: session } = useSession()
	const utils = api.useUtils()
	// The lesson page's writes go over tRPC, never server actions: Next's
	// router queues server actions with navigations, and the position save
	// that a pause starts just before `ended` replayed the old page over the
	// autoplay push.
	const { client } = utils

	const muxMetadata = useMuxMetadata({
		videoId: resource.id,
		videoTitle: title || resource.fields?.title,
		videoSeries: moduleSlug,
		contentType: moduleType || resource.type,
	})

	const playbackId = canView
		? playbackIdLoader
			? use(playbackIdLoader)
			: muxPlaybackId
		: muxPlaybackId
	const playerRef = React.useRef<MuxPlayerRefAttributes>(null)

	const chapters = React.useMemo(() => {
		if (videoChapters) return videoChapters
		const videoChild = resource.resources?.find(
			(r) => r.resource?.type === 'videoResource',
		)
		return videoChild?.resource?.fields?.chapters ?? null
	}, [resource, videoChapters])

	useMuxChapters(playerRef, chapters)
	const { dispatch: dispatchVideoPlayerOverlay } = useVideoPlayerOverlay()
	const { playerPrefs, setPlayerPrefs, setMuxPlayerRef } = useMuxPlayer()
	const bindVideoQuality = useVideoQualityPref(playerRef)
	const { playbackRate, volume, autoplay: bingeMode } = playerPrefs
	// The source whose start no longer depends on autoplay: it loaded with
	// autoplay off, or the browser refused to play it. Until then autoplay
	// will start it, and the shell hides the pre-play button.
	const [settledSourceId, setSettledSourceId] = React.useState<string | null>(
		null,
	)
	const willAutoplay = bingeMode && settledSourceId !== resource.id
	const minResolution = muxMinResolutionForPrefs(playerPrefs)
	const router = useRouter()
	const navigation = useWorkshopNavigation()

	const { nextResource, prevResource } = getAdjacentWorkshopResources(
		navigation,
		resource.id,
	)

	const next = getNextLesson({
		navigation,
		next: nextResource,
		moduleType: moduleType ?? 'workshop',
	})
	// Past 80%, fetch the whole next lesson (a FULL prefetch; the default one
	// stops at the layout for this dynamic route) and its card thumbnail, so
	// Continue and the autoplay countdown land on cached data. Under autoplay
	// also the still the next lesson's poster will show (see `poster`).
	const prefetchedHrefRef = React.useRef<string | null>(null)
	const prefetchNext = () => {
		if (!next || prefetchedHrefRef.current === next.href) return
		prefetchedHrefRef.current = next.href
		router.prefetch(next.href, { kind: PrefetchKind.FULL })
		if (next.thumbnailUrl) preload(next.thumbnailUrl, { as: 'image' })
		const arrivalPoster = getArrivalPosterUrl(next.resource)
		if (bingeMode && arrivalPoster) preload(arrivalPoster, { as: 'image' })
	}

	const searchParams = useSearchParams()
	const queryTime = normalizePlaybackPosition(searchParams.get('t'))
	const savedPlaybackPosition = playbackPositionLoader
		? use(playbackPositionLoader)
		: null
	// Where a saved position resumed this source; drives the resume chip.
	const [resume, setResume] = React.useState<{
		sourceId: string
		at: number
	} | null>(null)
	const resumedAt = resume?.sourceId === resource.id ? resume.at : null

	// Position events count only once this source's metadata is in: until
	// then they come from the outgoing source, or report 0 for the new one.
	const sourceReadyRef = React.useRef(false)
	const lastSavedAtRef = React.useRef(0)
	const lastSavedPositionRef = React.useRef<number | null>(null)
	const savePlaybackPosition = React.useMemo(
		() =>
			createPlaybackPositionSaveQueue((positionSeconds) =>
				client.progress.setPlaybackPosition.mutate({
					resourceId: resource.id,
					positionSeconds,
				}),
			),
		[client, resource.id],
	)
	const persistPlaybackPosition = React.useCallback(
		(position: unknown, force = false) => {
			if (!canView || !sourceReadyRef.current) return Promise.resolve(null)

			const normalizedPosition = normalizePlaybackPosition(position)
			if (normalizedPosition === null) return Promise.resolve(null)
			if (!force && Date.now() - lastSavedAtRef.current < 15_000) {
				return Promise.resolve(null)
			}
			if (normalizedPosition === lastSavedPositionRef.current) {
				return Promise.resolve(null)
			}

			lastSavedAtRef.current = Date.now()
			lastSavedPositionRef.current = normalizedPosition
			return savePlaybackPosition(normalizedPosition)
		},
		[canView, savePlaybackPosition],
	)
	const { moduleProgress, addLessonProgress, removeLessonProgress } =
		useModuleProgress()

	// Publish the ref to the shared context so consumers outside this tree
	// (transcript timestamp buttons) can drive the player.
	React.useEffect(() => {
		setMuxPlayerRef(playerRef)
	}, [setMuxPlayerRef])

	// A new source starts clean: no card from the last one, no save state.
	// Today the page remounts the player per lesson; this keeps it correct
	// once the player persists and only its source changes.
	React.useLayoutEffect(() => {
		sourceReadyRef.current = false
		lastSavedAtRef.current = 0
		lastSavedPositionRef.current = null
		dispatchVideoPlayerOverlay({ type: 'HIDDEN' })
	}, [resource.id, dispatchVideoPlayerOverlay])

	const playerProps = {
		defaultHiddenCaptions: true,
		streamType: 'on-demand',
		forwardSeekOffset: 5,
		backwardSeekOffset: 5,
		thumbnailTime: bingeMode ? 0 : resource.fields?.thumbnailTime || 0,
		// Arriving by autoplay, the first frame from the still the previous
		// lesson preloaded: Mux's own poster is a fresh fetch and the player
		// paints black until it lands.
		poster: (bingeMode && getArrivalPosterUrl(resource)) || undefined,
		playbackRates: [0.75, 1, 1.25, 1.5, 1.75, 2],
		maxResolution: '2160p',
		minResolution,
		accentColor: '#DD9637',
		// Only an explicit ?t=; a saved position needs the duration to judge,
		// so it is applied in onLoadedMetadata.
		currentTime: queryTime ?? undefined,
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
			handleTextTrackChange(playerRef, setPlayerPrefs)
			setPreferredPlaybackRate(playerRef, playbackRate)
			setPreferredTextTrack(playerRef)

			if (bingeMode) {
				playerRef?.current?.play().catch((error) => {
					console.warn(error)
					setSettledSourceId(resource.id)
				})
				return
			}
			setSettledSourceId(resource.id)
			if (queryTime !== null) playFromLink(playerRef.current)
		},
		onSeeked: () => {
			setPreferredPlaybackRate(playerRef, playbackRate)
		},
		onEnded: () => {
			setResume(null)
			prefetchNext()
			handleOnVideoEnded({
				resource,
				nextResource,
				prevResource,
				playerRef,
				currentResource: resource,
				dispatchVideoPlayerOverlay,
				bingeMode,
				moduleSlug,
				moduleType,
				router,
				moduleProgress,
				addLessonProgress,
				removeLessonProgress,
				navigation,
				canRecordProgress: Boolean(canView),
				hasSession: Boolean(session?.user),
				setCompleted: client.progress.setCompleted.mutate,
				// The cohort eligibility read may have raced the final write;
				// ask again once it is persisted.
				onModuleCompleted: () =>
					void utils.certificate.cohortEligibility.invalidate(),
			})
			void persistPlaybackPosition(0, true)
		},
		onPlay: () => {
			dispatchVideoPlayerOverlay({ type: 'HIDDEN' })
		},
		onPause: (evt: Event) => {
			const target = evt.target as HTMLVideoElement
			void persistPlaybackPosition(target.currentTime, true)
		},
		onTimeUpdate: (evt: Event) => {
			const target = evt.target as HTMLVideoElement
			void persistPlaybackPosition(target.currentTime)
			if (target.currentTime >= target.duration * 0.8) prefetchNext()
		},
	} as MuxPlayerProps

	return playbackId ? (
		<PlayerGestureShell
			playerRef={playerRef}
			className={cn(className)}
			autoplay={willAutoplay}
			overlay={
				<>
					<ResumeChip
						resumedAt={resumedAt}
						onStartOver={() => {
							const player = playerRef.current
							if (player) player.currentTime = 0
						}}
					/>
					{overlay}
				</>
			}
			chromeSlot={
				<AutoPlayToggle
					id="autoplay-player-chrome"
					className="rounded-[9px] bg-black/60 px-3 py-1.5 text-white"
				/>
			}
		>
			<MuxPlayer
				metadata={muxMetadata}
				ref={playerRef}
				playbackId={playbackId}
				className="h-full w-full"
				{...playerProps}
				{...props}
				onLoadedMetadata={(event) => {
					bindVideoQuality()
					const player = playerRef.current
					if (player && queryTime === null) {
						const start = getResumeStartTime({
							savedTime: savedPlaybackPosition,
							duration: player.duration,
						})
						if (start > 0) {
							player.currentTime = start
							setResume({ sourceId: resource.id, at: start })
						}
					}
					lastSavedPositionRef.current = normalizePlaybackPosition(
						player?.currentTime,
					)
					sourceReadyRef.current = true
					props.onLoadedMetadata?.(event)
				}}
			/>
		</PlayerGestureShell>
	) : null
}

function getResourceToComplete({
	currentResource,
	prevResource,
	navigation,
}: {
	currentResource: ContentResource
	prevResource?: ContentResource | null
	navigation: ResourceNavigation | null
}) {
	if (currentResource.type !== 'solution') {
		return currentResource
	}

	return (
		prevResource ||
		findParentLessonForSolution(navigation, currentResource.id) ||
		currentResource
	)
}

function createCompletedOverlayAction({
	playerRef,
	navigation,
	moduleProgress,
	currentResource,
	prevResource,
	nextResource,
}: {
	playerRef: React.RefObject<MuxPlayerRefAttributes | null>
	navigation: ResourceNavigation | null
	moduleProgress: ModuleProgress | null
	currentResource: ContentResource
	prevResource?: ContentResource | null
	nextResource?: ContentResource | null
}): CompletedAction {
	const resourceToComplete = getResourceToComplete({
		currentResource,
		prevResource,
		navigation,
	})
	const completionState = getModuleCompletionState({
		navigation,
		completedLessons: moduleProgress?.completedLessons,
		resourceIdToMarkComplete: resourceToComplete.id,
	})

	return {
		type: 'COMPLETED',
		playerRef,
		nextResource: nextResource || completionState.nextIncompleteResource,
		isModuleComplete: completionState.isModuleComplete,
	}
}

function handleOnVideoEnded({
	resource,
	playerRef,
	dispatchVideoPlayerOverlay,
	moduleProgress,
	addLessonProgress,
	removeLessonProgress,
	bingeMode,
	moduleSlug,
	moduleType,
	nextResource,
	prevResource,
	currentResource,
	router,
	navigation,
	canRecordProgress,
	hasSession,
	setCompleted,
	onModuleCompleted,
}: {
	resource: ContentResource
	playerRef: React.RefObject<MuxPlayerRefAttributes | null>
	dispatchVideoPlayerOverlay: React.Dispatch<VideoPlayerOverlayAction>
	currentResource: ContentResource
	bingeMode: boolean
	moduleSlug?: string
	moduleType?: 'tutorial' | 'workshop'
	nextResource?: ContentResource | null
	prevResource?: ContentResource | null
	router: ReturnType<typeof useRouter>
	moduleProgress: ModuleProgress | null
	addLessonProgress: (lessonId: string) => void
	removeLessonProgress: (lessonId: string) => void
	navigation: ResourceNavigation | null
	canRecordProgress: boolean
	hasSession: boolean
	setCompleted: (input: {
		resourceId: string
		isCompleted: boolean
	}) => Promise<unknown>
	onModuleCompleted: () => void
}) {
	void track('video_completed', {
		resourceSlug: resource?.fields?.slug,
		resourceType: resource?.type,
		moduleSlug: moduleSlug,
		moduleType: moduleType,
		bingeMode,
	})

	if (resource?.type === 'exercise') {
		router.push(`${resource?.fields?.slug}/exercise`)
		return
	}

	const completedAction = createCompletedOverlayAction({
		playerRef,
		navigation,
		moduleProgress,
		currentResource,
		prevResource,
		nextResource,
	})
	// With autoplay the card counts down to the next lesson and moves on
	// itself. Commit it before the completion lands, so the learner sees the
	// progress bar and count tick over under it.
	const action: EndCardAction = {
		...completedAction,
		autoAdvance: bingeMode && Boolean(nextResource),
	}
	flushSync(() => dispatchVideoPlayerOverlay(action))

	// Every mode completes on end, while the card is up and before any push.
	// A problem lesson completes on its solution.
	if (canRecordProgress && nextResource?.type !== 'solution') {
		void completeLessonInBackground({
			resourceId: getResourceToComplete({
				currentResource,
				prevResource,
				navigation,
			}).id,
			moduleProgress,
			addLessonProgress,
			removeLessonProgress,
			setCompleted,
			optimistic: hasSession,
		}).then(() => {
			if (completedAction.isModuleComplete) onModuleCompleted()
		})
	}
}
