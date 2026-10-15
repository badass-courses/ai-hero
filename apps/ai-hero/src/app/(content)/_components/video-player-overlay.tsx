'use client'

import React from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useCohortNavigation } from '@/app/(content)/workshops/_components/cohort-navigation-provider'
import { useWorkshopNavigation } from '@/app/(content)/workshops/_components/workshop-navigation-provider'
import Spinner from '@/components/spinner'
import {
	getNextCohortWorkshop,
	isWorkshopAvailable,
} from '@/lib/cohort-navigation'
import {
	findParentLessonForSolution,
	getModuleCompletionState,
} from '@/lib/content-navigation'
import { api } from '@/trpc/react'
import { getAdjacentWorkshopResources } from '@/utils/get-adjacent-workshop-resources'
import type { AbilityForResource } from '@/utils/get-current-ability-rules'
import { XMarkIcon } from '@heroicons/react/24/outline'
import { ArrowRight } from 'lucide-react'
import { useSession } from 'next-auth/react'
import pluralize from 'pluralize'
import { useReward } from 'react-rewards'

import type { ContentResource } from '@coursebuilder/core/schemas'
import { Button, Progress } from '@coursebuilder/ui'
import { useVideoPlayerOverlay } from '@coursebuilder/ui/hooks/use-video-player-overlay'
import type { CompletedAction } from '@coursebuilder/ui/hooks/use-video-player-overlay'
import { cn } from '@coursebuilder/ui/utils/cn'
import { getResourcePath } from '@coursebuilder/utils/resource-paths'

import { CopyProblemPromptButton } from '../workshops/_components/copy-problem-prompt-button'
import * as ModuleCertificate from '@/components/certificates/module-certificate'

import { completeLessonInBackground } from './complete-lesson-in-background'
import {
	CohortCertificateAction,
	useCohortCertificateEligibility,
} from './cohort-certificate-container'
import { CertificateDialog } from './module-certificate-container'
import { useModuleProgress } from './module-progress-provider'

export const CompletedLessonOverlay: React.FC<{
	action: CompletedAction
	resource: ContentResource | null
	moduleType?: 'workshop' | 'tutorial'
	moduleSlug?: string
	abilityLoader: Promise<
		Omit<AbilityForResource, 'canView'> & {
			canViewWorkshop: boolean
			canViewLesson: boolean
			isPendingOpenAccess: boolean
		}
	>
}> = ({
	action,
	resource,
	moduleType = 'tutorial',
	moduleSlug,
	abilityLoader,
}) => {
	const { playerRef } = action
	const workshopNavigation = useWorkshopNavigation()
	const { nextResource: adjacentNextLesson, prevResource: prevLesson } =
		getAdjacentWorkshopResources(workshopNavigation, resource?.id as string)
	const nextLesson = action.nextResource || adjacentNextLesson
	const isSolutionNext = nextLesson?.type === 'solution'

	const { dispatch: dispatchVideoPlayerOverlay } = useVideoPlayerOverlay()
	const { moduleProgress } = useModuleProgress()
	const { data: session } = useSession()

	const percentCompleted = moduleProgress?.percentCompleted || 0

	// Decide "is the workshop finished" from live progress, not from the
	// snapshot the ended handler captured. That snapshot can lag the durable
	// state and has shown a learner "Up Next: <lesson 1>" beside "6/6
	// completed" on the last lesson, which also hides the certificate.
	const resourceToComplete =
		resource?.type === 'solution'
			? prevLesson || findParentLessonForSolution(workshopNavigation, resource.id)
			: resource
	// Without navigation there is no lesson list to check against, and an empty
	// list would read as "everything done"; keep the handler's answer then.
	const isModuleComplete =
		action.isModuleComplete ||
		(Boolean(workshopNavigation) &&
			getModuleCompletionState({
				navigation: workshopNavigation,
				completedLessons: moduleProgress?.completedLessons,
				resourceIdToMarkComplete: resourceToComplete?.id,
			}).isModuleComplete)

	return nextLesson && !isModuleComplete ? (
		<div
			aria-live="polite"
			className="bg-background/80 absolute inset-0 z-40 flex flex-col items-center justify-center gap-3 p-5 text-lg text-white backdrop-blur-md sm:gap-5 lg:gap-10"
		>
			<div className="flex flex-col items-center text-center">
				<p className="pb-2 text-sm opacity-80 sm:text-base">
					{isSolutionNext
						? `Now Watch ${process.env.NEXT_PUBLIC_PARTNER_FIRST_NAME || 'Instructor'}'s Solution`
						: 'Up Next:'}
				</p>
				<p className="font-heading text-xl font-bold sm:text-2xl">
					{nextLesson?.type === 'solution'
						? findParentLessonForSolution(workshopNavigation, nextLesson.id)
								?.fields?.title || 'Next Resource'
						: nextLesson?.fields?.title || 'Next Resource'}
				</p>
				{session?.user ? (
					<div className="mt-3 flex items-center gap-3 text-sm sm:mt-8">
						<Progress
							value={percentCompleted}
							className="bg-foreground/20 h-1 w-[150px] sm:w-[200px]"
						/>
						<div className="opacity-85">
							{moduleProgress?.completedLessonsCount || 0}/
							{moduleProgress?.totalLessonsCount || 0} completed
						</div>
					</div>
				) : (
					<div className="mt-3 text-sm sm:mt-8">
						<Link
							href="/login"
							className="dark:text-primary text-blue-600 hover:underline"
						>
							Log in
						</Link>{' '}
						to track your progress.
					</div>
				)}
			</div>
			<div className="flex w-full items-center justify-center gap-3">
				<Button
					variant="ghost"
					type="button"
					onClick={() => {
						if (playerRef.current) {
							playerRef.current.play()
						}
					}}
				>
					Replay
				</Button>
				{resource && resource.type !== 'solution' && (
					<CopyProblemPromptButton
						abilityLoader={abilityLoader}
						className="dark:bg-primary/20 dark:hover:bg-primary/30 dark:text-primary h-10 bg-white/20 px-4 text-sm text-white transition hover:bg-white/30"
						lesson={resource}
						variant="default"
					/>
				)}
				{resource && (
					<ContinueButton
						className="h-10"
						moduleType={moduleType}
						resource={resource}
						nextResource={nextLesson}
						prevResource={prevLesson}
					/>
				)}
			</div>
			<Button
				type="button"
				className="absolute right-3 top-3 h-8 w-8 bg-white/10 sm:right-5 sm:top-5 sm:h-10 sm:w-10"
				variant="ghost"
				size="icon"
				onClick={() => {
					dispatchVideoPlayerOverlay({ type: 'HIDDEN' })
				}}
			>
				<span className="sr-only">Dismiss</span>
				<XMarkIcon aria-hidden="true" className="h-4 w-4 sm:h-6 sm:w-6" />
			</Button>
		</div>
	) : (
		<CompletedModuleOverlay
			action={action}
			resource={resource}
			moduleType={moduleType}
			moduleSlug={moduleSlug}
			prevResource={prevLesson}
		/>
	)
}

export const CompletedModuleOverlay: React.FC<{
	action: CompletedAction
	resource: ContentResource | null
	moduleType?: 'workshop' | 'tutorial'
	moduleSlug?: string
	prevResource?: any
}> = ({
	action,
	resource,
	moduleType = 'tutorial',
	moduleSlug,
	prevResource,
}) => {
	const { playerRef } = action
	const session = useSession()
	const { dispatch: dispatchVideoPlayerOverlay } = useVideoPlayerOverlay()
	const moduleNavigation = useWorkshopNavigation()
	const { moduleProgress, addLessonProgress, removeLessonProgress } =
		useModuleProgress()
	const utils = api.useUtils()
	const isCurrentLessonCompleted = Boolean(
		moduleProgress?.completedLessons?.some(
			(p) => p.resourceId === resource?.id && p.completedAt,
		),
	)
	const { reward, isAnimating } = useReward('rewardId', 'confetti', {
		angle: 90,
		decay: 0.9,
		spread: 100,
	})

	React.useEffect(() => {
		if (!resource) return
		reward()
		if (isCurrentLessonCompleted) return
		const resourceToComplete =
			resource.type === 'solution' && prevResource ? prevResource : resource
		void completeLessonInBackground({
			resourceId: resourceToComplete.id,
			moduleProgress,
			addLessonProgress,
			removeLessonProgress,
		}).then(() =>
			// The cohort eligibility read may have raced this write; ask again
			// now that the final lesson is persisted.
			utils.certificate.cohortEligibility.invalidate(),
		)
	}, []) // Empty deps array to only run once on mount

	// Reads the cohort from context rather than its own tRPC round trip. This
	// used to call `getNextWorkshopInCohort`, which was a second, subtly
	// different answer to "what comes next": it linked to the next workshop's
	// LANDING page (the "do I need to go to some overview and navigate again?"
	// complaint) and it ignored release state, so it could offer a workshop
	// that had not dropped yet. One source now, shared with the sidebar and the
	// end-of-workshop card.
	const cohortNavigation = useCohortNavigation()
	const nextWorkshop = getNextCohortWorkshop(
		cohortNavigation,
		moduleNavigation?.id,
	)
	// The last workshop of a cohort is where the cohort certificate is earned.
	// Its eligibility is a server read; when it comes back positive the cohort
	// certificate takes the gold slot and the workshop's own drops to outline.
	const isLastCohortWorkshop = Boolean(cohortNavigation && !nextWorkshop)
	const canClaimCohortCertificate =
		useCohortCertificateEligibility(
			isLastCohortWorkshop ? cohortNavigation : null,
		) && Boolean(cohortNavigation)
	const nextWorkshopHref =
		nextWorkshop && isWorkshopAvailable(nextWorkshop)
			? nextWorkshop.firstLesson
				? getResourcePath('lesson', nextWorkshop.firstLesson.slug, 'view', {
						parentType: 'workshop',
						parentSlug: nextWorkshop.slug,
					})
				: getResourcePath('workshop', nextWorkshop.slug, 'view')
			: null

	// The certificate is claimed here, at the moment it's earned. Before this
	// the only mention was a sidebar tile on the landing page, so a learner who
	// finished on the lesson page never learned one existed. Primary when the
	// workshop is the end of the road; when a next workshop follows, that stays
	// the primary action and the certificate sits beside it.
	const replayButton = (
		<Button
			className="rounded-md border border-white/20 bg-white/10 hover:bg-white/20"
			variant="outline"
			type="button"
			onClick={() => {
				if (playerRef.current) {
					playerRef.current.play()
				}
			}}
		>
			Replay
		</Button>
	)
	const actions =
		nextWorkshop && nextWorkshopHref ? (
			<>
				{replayButton}
				{moduleSlug && (
					<ModuleCertificate.Trigger className="rounded-md border border-white/20 bg-white/10 text-white hover:bg-white/20">
						Get your certificate
					</ModuleCertificate.Trigger>
				)}
				<Button asChild variant="default">
					<Link href={nextWorkshopHref}>Continue to {nextWorkshop.title}</Link>
				</Button>
			</>
		) : (
			<>
				{replayButton}
				{moduleSlug && (
					<ModuleCertificate.Trigger
						className={
							canClaimCohortCertificate
								? 'rounded-md border border-white/20 bg-white/10 text-white hover:bg-white/20'
								: 'bg-accent-fill text-accent-fill-foreground hover:bg-accent-fill-hover rounded-md font-bold'
						}
					>
						Get your certificate
					</ModuleCertificate.Trigger>
				)}
				{canClaimCohortCertificate && cohortNavigation && (
					<CohortCertificateAction
						cohort={cohortNavigation}
						className="bg-accent-fill text-accent-fill-foreground hover:bg-accent-fill-hover rounded-md font-bold"
					/>
				)}
			</>
		)

	const overlay = (
		<div
			aria-live="polite"
			className="absolute inset-0 z-40 flex flex-col items-center justify-center gap-2 bg-gray-900/80 p-5 text-lg text-white backdrop-blur-md sm:gap-5 xl:gap-5"
		>
			<p className="font-heading text-center text-xl font-bold">Great job!</p>
			<p className="text-center text-sm sm:text-base">
				You&apos;ve completed the "{moduleNavigation?.fields?.title}"{' '}
				{moduleType}.
			</p>
			<span id="rewardId" />
			<div className="flex w-full flex-wrap items-center justify-center gap-3">
				{actions}
			</div>
			<Button
				type="button"
				className="text-foreground absolute right-5 top-5"
				variant="outline"
				size="icon"
				onClick={() => {
					dispatchVideoPlayerOverlay({ type: 'HIDDEN' })
				}}
			>
				<span className="sr-only">Dismiss</span>
				<XMarkIcon aria-hidden="true" className="h-4 w-4" />
			</Button>
		</div>
	)

	if (!moduleSlug) return overlay
	return (
		<ModuleCertificate.Root resourceIdOrSlug={moduleSlug}>
			{overlay}
			<CertificateDialog />
		</ModuleCertificate.Root>
	)
}

const ContinueButton: React.FC<{
	resource: ContentResource
	moduleType: 'workshop' | 'tutorial'
	nextResource?: ContentResource
	prevResource?: ContentResource | null
	className?: string
}> = ({
	resource,
	nextResource,
	prevResource = null,
	moduleType,
	className,
}) => {
	const router = useRouter()
	const pathname = usePathname()
	const { moduleProgress, addLessonProgress, removeLessonProgress } =
		useModuleProgress()
	const moduleNavigation = useWorkshopNavigation()
	const isCurrentLessonCompleted = Boolean(
		moduleProgress?.completedLessons?.some(
			(p) => p.resourceId === resource.id && p.completedAt,
		),
	)

	const isProblemLesson = Boolean(
		resource?.resources?.find((r) => r.resource.type === 'solution'),
	)

	const isSolution = pathname.endsWith('/solution')

	// Pending covers the navigation only. The progress write stays outside
	// the transition so the next lesson never waits on it.
	const [isNavigating, startNavigation] = React.useTransition()
	const { data: session } = useSession()

	const href =
		nextResource && moduleNavigation
			? nextResource.type === 'solution'
				? `/${pluralize(moduleType)}/${moduleNavigation.fields?.slug}/${resource?.fields?.slug}/solution`
				: `/${pluralize(moduleType)}/${moduleNavigation.fields?.slug}/${nextResource?.fields?.slug}`
			: null

	return (
		<Button
			className={cn(
				'dark:bg-primary dark:hover:bg-primary/90 dark:text-primary-foreground cursor-pointer bg-white text-black hover:bg-white/80',
				className,
			)}
			onClick={() => {
				if (!isProblemLesson) {
					// On a solution, the lesson to complete is the problem before it.
					void completeLessonInBackground({
						resourceId:
							isSolution && prevResource ? prevResource.id : resource.id,
						moduleProgress,
						addLessonProgress,
						removeLessonProgress,
					})
				}
				if (href) startNavigation(() => router.push(href))
			}}
			type="button"
			disabled={isNavigating}
		>
			{/* Keep the label steady while navigating: the urgent completion
			    flips isCurrentLessonCompleted mid-click. */}
			{(isCurrentLessonCompleted && !isNavigating) || !session?.user
				? 'Continue'
				: isProblemLesson
					? 'Continue'
					: 'Complete & Continue'}
			{isNavigating ? (
				<Spinner className="ml-2 size-4" />
			) : (
				<ArrowRight className="ml-2 size-4" />
			)}
		</Button>
	)
}

type VideoPlayerOverlayProps = {
	resource: ContentResource
	abilityLoader: Promise<
		Omit<AbilityForResource, 'canView'> & {
			canViewWorkshop: boolean
			canViewLesson: boolean
			isPendingOpenAccess: boolean
		}
	>
	moduleType?: 'workshop' | 'tutorial'
	moduleSlug?: string
}

/**
 * The end-of-video card. Only the workshop lesson page renders it, inside the
 * player shell so it survives fullscreen, and that page redirects anyone who
 * cannot view the lesson. Completion is therefore the only state left to draw.
 */
const VideoPlayerOverlay: React.FC<VideoPlayerOverlayProps> = ({
	resource,
	abilityLoader,
	moduleType = 'tutorial',
	moduleSlug,
}) => {
	const { state: overlayState } = useVideoPlayerOverlay()

	if (overlayState.action?.type !== 'COMPLETED') return null
	return (
		<CompletedLessonOverlay
			action={overlayState.action}
			resource={resource}
			moduleType={moduleType}
			moduleSlug={moduleSlug}
			abilityLoader={abilityLoader}
		/>
	)
}

export default VideoPlayerOverlay
