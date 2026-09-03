'use client'

import * as React from 'react'
import { use } from 'react'
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
import {
	setPlaybackPositionForResource,
	setProgressForResource,
} from '@/lib/progress'
import {
	createPlaybackPositionSaveQueue,
	getPlaybackStartTime,
	normalizePlaybackPosition,
} from '@/lib/playback-position'
import { track } from '@/utils/analytics'
import { getAdjacentWorkshopResources } from '@/utils/get-adjacent-workshop-resources'
import type { AbilityForResource } from '@/utils/get-current-ability-rules'
import MuxPlayer, {
	type MuxPlayerProps,
	type MuxPlayerRefAttributes,
} from '@mux/mux-player-react'

import type {
	ContentResource,
	ContentResourceResource,
	ModuleProgress,
	VideoChapter,
} from '@coursebuilder/core/schemas'
import {
	useVideoPlayerOverlay,
	type VideoPlayerOverlayAction,
} from '@coursebuilder/ui/hooks/use-video-player-overlay'
import { cn } from '@coursebuilder/ui/utils/cn'
import { getResourcePath } from '@coursebuilder/utils/resource-paths'

import { revalidateModuleLesson } from '../actions'
import { useWorkshopNavigation } from '../workshops/_components/workshop-navigation-provider'
import { AutoPlayToggle } from './autoplay-toggle'
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
} & MuxPlayerProps) {
	const ability = abilityLoader ? use(abilityLoader) : null
	const canView = ability?.canViewLesson

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
	const [currentResource, setCurrentResource] =
		React.useState<ContentResource>(resource)

	const navigation = useWorkshopNavigation()

	const { nextResource, prevResource } = getAdjacentWorkshopResources(
		navigation,
		currentResource.id,
	)

	const isProblemLesson = Boolean(
		resource?.resources?.find((r) => r.resource.type === 'solution'),
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
	const { moduleProgress, addLessonProgress } = useModuleProgress()
	const [isPending, startTransition] = React.useTransition()

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
			}
		},
		onSeeked: () => {
			setPreferredPlaybackRate(playerRef, playbackRate)
		},
		onEnded: () => {
			startTransition(async () => {
				await persistPlaybackPosition(0, true)
				await handleOnVideoEnded({
					canView,
					resource,
					nextResource,
					prevResource,
					playerRef,
					currentResource,
					dispatchVideoPlayerOverlay,
					setCurrentResource,
					handleSetLessonComplete,
					bingeMode,
					moduleSlug,
					moduleType,
					router,
					moduleProgress,
					addLessonProgress,
					navigation,
				})
			})
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
}): VideoPlayerOverlayAction {
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

async function handleOnVideoEnded({
	resource,
	playerRef,
	dispatchVideoPlayerOverlay,
	setCurrentResource,
	handleSetLessonComplete,
	moduleProgress,
	addLessonProgress,
	bingeMode,
	moduleSlug,
	moduleType,
	nextResource,
	prevResource,
	currentResource,
	canView,
	router,
	navigation,
}: {
	canView?: boolean
	resource: ContentResource
	playerRef: React.RefObject<MuxPlayerRefAttributes | null>
	dispatchVideoPlayerOverlay: React.Dispatch<VideoPlayerOverlayAction>
	setCurrentResource: React.Dispatch<any>
	currentResource: ContentResource
	handleSetLessonComplete: (
		props: handleSetLessonCompleteProps,
	) => Promise<void>
	bingeMode: boolean
	moduleSlug?: string
	moduleType?: 'tutorial' | 'workshop'
	nextResource?: ContentResource | null
	prevResource?: ContentResource | null
	router: ReturnType<typeof useRouter>
	moduleProgress: ModuleProgress | null
	addLessonProgress: (lessonId: string) => void
	navigation: ResourceNavigation | null
}) {
	await track('video_completed', {
		resourceSlug: resource?.fields?.slug,
		resourceType: resource?.type,
		moduleSlug: moduleSlug,
		moduleType: moduleType,
		bingeMode,
	})

	const resourceToComplete = getResourceToComplete({
		currentResource,
		prevResource,
		navigation,
	})

	if (resource?.type === 'exercise') {
		router.push(`${resource?.fields?.slug}/exercise`)
	} else {
		if (bingeMode && nextResource && playerRef?.current) {
			dispatchVideoPlayerOverlay({ type: 'LOADING' })
			// playerRef.current.playbackId = nextLessonPlaybackId
			if (nextResource.type !== 'solution') {
				console.log('setting lesson complete', resourceToComplete)
				await handleSetLessonComplete({
					currentResource: resourceToComplete,
					moduleProgress,
					addLessonProgress,
				})
			}

			await revalidateModuleLesson(
				moduleSlug as string,
				currentResource.fields?.slug as string,
				moduleType,
				currentResource.type as 'lesson' | 'exercise' | 'solution',
			)
			const nextResourceType = nextResource.type
			// For solution resources, use the parent lesson's slug instead of the solution's slug
			const nextResourceSlug =
				nextResourceType === 'solution' && navigation
					? findParentLessonForSolution(navigation, nextResource.id)?.fields
							?.slug || nextResource.fields?.slug
					: nextResource.fields?.slug

			if (nextResourceType && nextResourceSlug && moduleType && moduleSlug) {
				router.push(
					getResourcePath(nextResourceType, nextResourceSlug, 'view', {
						parentType: moduleType,
						parentSlug: moduleSlug,
					}),
				)
			} else {
				console.error('Missing required resource or module data for navigation')
			}
		} else if (bingeMode) {
			if (nextResource) {
				dispatchVideoPlayerOverlay({ type: 'LOADING' })
			}

			await handleSetLessonComplete({
				currentResource: resourceToComplete,
				moduleProgress,
				addLessonProgress,
			})
			await revalidateModuleLesson(
				moduleSlug as string,
				currentResource.fields?.slug as string,
				moduleType,
				currentResource.type as 'lesson' | 'exercise' | 'solution',
			)

			if (nextResource) {
				// For solution resources, use the parent lesson's slug instead of the solution's slug
				const nextResourceSlug =
					nextResource.type === 'solution' && navigation
						? findParentLessonForSolution(navigation, nextResource.id)?.fields
								?.slug ||
							nextResource.fields?.slug ||
							''
						: nextResource.fields?.slug || ''
				// setTimeout(() => {
				router.push(
					getResourcePath(nextResource.type || '', nextResourceSlug, 'view', {
						parentType: moduleType as string,
						parentSlug: moduleSlug as string,
					}),
				)
				// }, 250)
			} else {
				dispatchVideoPlayerOverlay(
					createCompletedOverlayAction({
						playerRef,
						navigation,
						moduleProgress,
						currentResource,
						prevResource,
						nextResource,
					}),
				)
			}
		} else {
			dispatchVideoPlayerOverlay(
				createCompletedOverlayAction({
					playerRef,
					navigation,
					moduleProgress,
					currentResource,
					prevResource,
					nextResource,
				}),
			)
		}
	}
}

type handleSetLessonCompleteProps = {
	currentResource: ContentResource
	moduleProgress: ModuleProgress | null
	addLessonProgress: (lessonId: string) => void
}

export async function handleSetLessonComplete({
	currentResource,
	moduleProgress,
	addLessonProgress,
}: handleSetLessonCompleteProps) {
	const isCurrentLessonCompleted = Boolean(
		moduleProgress?.completedLessons?.some(
			(p) => p.resourceId === currentResource.id && p.completedAt,
		),
	)
	if (!isCurrentLessonCompleted) {
		addLessonProgress(currentResource.id)
		await setProgressForResource({
			resourceId: currentResource.id,
			isCompleted: true,
		})
	}
}
