'use client'

import * as React from 'react'
import { use } from 'react'
import { flushSync } from 'react-dom'
import { useRouter, useSearchParams } from 'next/navigation'
import { PlayerGestureShell } from '@/components/player/player-gesture-shell'
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
import { setPlaybackPositionForResource } from '@/lib/progress'
import {
	createPlaybackPositionSaveQueue,
	getPlaybackStartTime,
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
import { getResourcePath } from '@coursebuilder/utils/resource-paths'

import { useWorkshopNavigation } from '../workshops/_components/workshop-navigation-provider'
import { playFromLink } from './play-from-link'
import { AutoPlayToggle } from './autoplay-toggle'
import { completeLessonInBackground } from './complete-lesson-in-background'
import { useModuleProgress } from './module-progress-provider'

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
	// Signed out the write returns null and the store would flip back.
	const canRecordProgress = Boolean(canView && session?.user)
	const utils = api.useUtils()

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
	const minResolution = muxMinResolutionForPrefs(playerPrefs)
	const router = useRouter()
	const navigation = useWorkshopNavigation()

	const { nextResource, prevResource } = getAdjacentWorkshopResources(
		navigation,
		resource.id,
	)

	const searchParams = useSearchParams()
	const time = searchParams.get('t')
	const savedPlaybackPosition = playbackPositionLoader
		? use(playbackPositionLoader)
		: null
	const playbackStartTime = getPlaybackStartTime({
		queryTime: time,
		savedTime: savedPlaybackPosition,
	})
	const lastSavedAtRef = React.useRef(0)
	const lastSavedPositionRef = React.useRef(playbackStartTime)
	const savePlaybackPosition = React.useMemo(
		() =>
			createPlaybackPositionSaveQueue((positionSeconds) =>
				setPlaybackPositionForResource({
					resourceId: resource.id,
					positionSeconds,
				}),
			),
		[resource.id],
	)
	const persistPlaybackPosition = React.useCallback(
		(position: unknown, force = false) => {
			if (!canView) return Promise.resolve(null)

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

	const playerProps = {
		defaultHiddenCaptions: true,
		streamType: 'on-demand',
		forwardSeekOffset: 5,
		backwardSeekOffset: 5,
		thumbnailTime: bingeMode ? 0 : resource.fields?.thumbnailTime || 0,
		playbackRates: [0.75, 1, 1.25, 1.5, 1.75, 2],
		maxResolution: '2160p',
		minResolution,
		accentColor: '#DD9637',
		currentTime: playbackStartTime,
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
			setPreferredPlaybackRate(playerRef, playbackRate)
			setPreferredTextTrack(playerRef)

			if (bingeMode) {
				playerRef?.current?.play().catch(console.warn)
			} else if (normalizePlaybackPosition(time) !== null) {
				playFromLink(playerRef.current)
			}
		},
		onSeeked: () => {
			setPreferredPlaybackRate(playerRef, playbackRate)
		},
		onEnded: () => {
			// The card first: the position reset is a server action queued
			// behind the save the preceding pause already started.
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
				canRecordProgress,
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
		},
	} as MuxPlayerProps

	return playbackId ? (
		<PlayerGestureShell
			playerRef={playerRef}
			className={cn(className)}
			overlay={overlay}
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
	const showCard = !bingeMode || !nextResource
	// Commit the card before the completion lands, so the learner sees the
	// progress bar and count tick over under it.
	if (showCard) flushSync(() => dispatchVideoPlayerOverlay(completedAction))

	// Every mode completes on end. Dispatched before any push so it never
	// holds the navigation up. A problem lesson completes on its solution.
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
		}).then(() => {
			if (completedAction.isModuleComplete) onModuleCompleted()
		})
	}

	if (showCard || !nextResource) return

	// For solution resources, use the parent lesson's slug instead of the solution's slug
	const nextResourceSlug =
		nextResource.type === 'solution' && navigation
			? findParentLessonForSolution(navigation, nextResource.id)?.fields
					?.slug || nextResource.fields?.slug
			: nextResource.fields?.slug

	if (nextResource.type && nextResourceSlug && moduleType && moduleSlug) {
		router.push(
			getResourcePath(nextResource.type, nextResourceSlug, 'view', {
				parentType: moduleType,
				parentSlug: moduleSlug,
			}),
		)
	} else {
		console.error('Missing required resource or module data for navigation')
	}
}
