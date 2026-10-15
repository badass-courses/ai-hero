'use client'

import React, { use } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useCohortNavigation } from '@/app/(content)/workshops/_components/cohort-navigation-provider'
import { useWorkshopNavigation } from '@/app/(content)/workshops/_components/workshop-navigation-provider'
import { TYPE } from '@/components/landing/type'
import Spinner from '@/components/spinner'
import {
	getNextCohortWorkshop,
	isWorkshopAvailable,
} from '@/lib/cohort-navigation'
import {
	findParentLessonForSolution,
	getModuleCompletionState,
} from '@/lib/content-navigation'
import { getAdjacentWorkshopResources } from '@/utils/get-adjacent-workshop-resources'
import type { AbilityForResource } from '@/utils/get-current-ability-rules'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
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
import { EndCard, END_CARD_SECONDARY, EndCardItem } from './end-card'
import { CertificateDialog } from './module-certificate-container'
import { useModuleProgress } from './module-progress-provider'

type AbilityLoader = Promise<
	Omit<AbilityForResource, 'canView'> & {
		canViewWorkshop: boolean
		canViewLesson: boolean
		isPendingOpenAccess: boolean
	}
>

const easeOutQuint = [0.22, 1, 0.36, 1] as const

const END_CARD_PRIMARY =
	'bg-accent-fill text-accent-fill-foreground hover:bg-accent-fill-hover h-10 rounded-[9px] px-4 font-bold'

/**
 * Signed out there is nothing to record: the store would flip on and then
 * revert when the write returns null, and the sidebar check would flicker.
 */
function useCanRecordProgress(abilityLoader: AbilityLoader) {
	const { data: session } = useSession()
	const ability = use(abilityLoader)
	return Boolean(session?.user && ability.canViewLesson)
}

/** The count rolls over when the lesson's completion lands under the card. */
function RollingCount({ value }: { value: number }) {
	const reduceMotion = useReducedMotion()
	return (
		<span className="inline-grid overflow-hidden">
			<AnimatePresence initial={false}>
				<motion.span
					key={value}
					className="[grid-area:1/1]"
					initial={{ opacity: 0, y: reduceMotion ? 0 : '100%' }}
					animate={{ opacity: 1, y: 0 }}
					exit={{ opacity: 0, y: reduceMotion ? 0 : '-100%' }}
					// Waits for the card's rows to rise first.
					transition={{ duration: 0.25, ease: easeOutQuint, delay: 0.25 }}
				>
					{value}
				</motion.span>
			</AnimatePresence>
		</span>
	)
}

function ModuleProgressLine() {
	const { moduleProgress } = useModuleProgress()
	return (
		<div className="flex items-center gap-3">
			<Progress
				value={moduleProgress?.percentCompleted || 0}
				// Progress already transitions its indicator; retime it to land
				// with the rolling count.
				className="h-1 w-[150px] bg-white/20 sm:w-[200px] [&_[data-indicator]]:delay-250 [&_[data-indicator]]:duration-250 [&_[data-indicator]]:ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:[&_[data-indicator]]:transition-none"
			/>
			<span className={cn(TYPE.metaMark, 'tabular-nums text-white/80')}>
				<RollingCount value={moduleProgress?.completedLessonsCount || 0} />/
				{moduleProgress?.totalLessonsCount || 0} completed
			</span>
		</div>
	)
}

export const CompletedLessonOverlay: React.FC<{
	action: CompletedAction
	resource: ContentResource | null
	moduleType?: 'workshop' | 'tutorial'
	moduleSlug?: string
	abilityLoader: AbilityLoader
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

	const { moduleProgress } = useModuleProgress()
	const { data: session } = useSession()
	const canRecordProgress = useCanRecordProgress(abilityLoader)

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

	if (!nextLesson || isModuleComplete)
		return (
			<CompletedModuleOverlay
				action={action}
				moduleType={moduleType}
				moduleSlug={moduleSlug}
			/>
		)

	return (
		<EndCard>
			<EndCardItem>
				<p className={cn(TYPE.meta, 'pb-1 text-white/70')}>
					{isSolutionNext
						? `Now watch ${process.env.NEXT_PUBLIC_PARTNER_FIRST_NAME || 'Instructor'}'s solution`
						: 'Up next'}
				</p>
				<p className={TYPE.subhead}>
					{nextLesson?.type === 'solution'
						? findParentLessonForSolution(workshopNavigation, nextLesson.id)
								?.fields?.title || 'Next Resource'
						: nextLesson?.fields?.title || 'Next Resource'}
				</p>
			</EndCardItem>
			<EndCardItem>
				{session?.user ? (
					<ModuleProgressLine />
				) : (
					<p className={cn(TYPE.meta, 'font-normal text-white/80')}>
						<Link
							href="/login"
							className="focus-visible:ring-ring -mx-2 inline-flex min-h-11 items-center rounded-[9px] px-2 font-medium text-white underline underline-offset-4 hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2"
						>
							Log in
						</Link>{' '}
						to track your progress.
					</p>
				)}
			</EndCardItem>
			<EndCardItem className="flex w-full flex-wrap items-center justify-center gap-3">
				<Button
					variant="ghost"
					type="button"
					className={END_CARD_SECONDARY}
					onClick={() => playerRef.current?.play()}
				>
					Replay
				</Button>
				{resource && resource.type !== 'solution' && (
					<CopyProblemPromptButton
						abilityLoader={abilityLoader}
						className={END_CARD_SECONDARY}
						lesson={resource}
						variant="default"
					/>
				)}
				{resource && (
					<ContinueButton
						moduleType={moduleType}
						resource={resource}
						nextResource={nextLesson}
						prevResource={prevLesson}
						canRecordProgress={canRecordProgress}
					/>
				)}
			</EndCardItem>
		</EndCard>
	)
}

/**
 * The workshop is done. The lesson was already marked complete when the video
 * ended (see `AuthedVideoPlayer`), so this card only celebrates and points on.
 */
export const CompletedModuleOverlay: React.FC<{
	action: CompletedAction
	moduleType?: 'workshop' | 'tutorial'
	moduleSlug?: string
}> = ({ action, moduleType = 'tutorial', moduleSlug }) => {
	const { playerRef } = action
	const moduleNavigation = useWorkshopNavigation()
	const reduceMotion = useReducedMotion()
	const { reward } = useReward('rewardId', 'confetti', {
		angle: 90,
		decay: 0.9,
		spread: 100,
	})

	React.useEffect(() => {
		if (!reduceMotion) reward()
		// Once per card, on arrival.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [])

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
			className={END_CARD_SECONDARY}
			variant="outline"
			type="button"
			onClick={() => playerRef.current?.play()}
		>
			Replay
		</Button>
	)
	const actions =
		nextWorkshop && nextWorkshopHref ? (
			<>
				{replayButton}
				{moduleSlug && (
					<ModuleCertificate.Trigger className={END_CARD_SECONDARY}>
						Get your certificate
					</ModuleCertificate.Trigger>
				)}
				<Button asChild variant="default" className={END_CARD_PRIMARY}>
					<Link
						href={nextWorkshopHref}
						data-end-card-primary=""
						data-end-card-continue=""
					>
						Continue to {nextWorkshop.title}
					</Link>
				</Button>
			</>
		) : (
			<>
				{replayButton}
				{moduleSlug && (
					<span
						className="contents"
						data-end-card-primary={canClaimCohortCertificate ? undefined : ''}
					>
						<ModuleCertificate.Trigger
							className={
								canClaimCohortCertificate ? END_CARD_SECONDARY : END_CARD_PRIMARY
							}
						>
							Get your certificate
						</ModuleCertificate.Trigger>
					</span>
				)}
				{canClaimCohortCertificate && cohortNavigation && (
					<span className="contents" data-end-card-primary="">
						<CohortCertificateAction
							cohort={cohortNavigation}
							className={END_CARD_PRIMARY}
						/>
					</span>
				)}
			</>
		)

	const card = (
		<EndCard>
			<EndCardItem>
				<p className={TYPE.subhead}>Great job!</p>
				<p className={cn(TYPE.meta, 'pt-1 font-normal text-white/80')}>
					You&apos;ve completed the "{moduleNavigation?.fields?.title}"{' '}
					{moduleType}.
				</p>
				<span id="rewardId" />
			</EndCardItem>
			<EndCardItem className="flex w-full flex-wrap items-center justify-center gap-3">
				{actions}
			</EndCardItem>
		</EndCard>
	)

	if (!moduleSlug) return card
	return (
		<ModuleCertificate.Root resourceIdOrSlug={moduleSlug}>
			{card}
			<CertificateDialog />
		</ModuleCertificate.Root>
	)
}

const ContinueButton: React.FC<{
	resource: ContentResource
	moduleType: 'workshop' | 'tutorial'
	nextResource?: ContentResource
	prevResource?: ContentResource | null
	canRecordProgress: boolean
}> = ({
	resource,
	nextResource,
	prevResource = null,
	moduleType,
	canRecordProgress,
}) => {
	const router = useRouter()
	const pathname = usePathname()
	const { moduleProgress, addLessonProgress, removeLessonProgress } =
		useModuleProgress()
	const moduleNavigation = useWorkshopNavigation()

	const isSolution = pathname.endsWith('/solution')

	// Pending covers the navigation only. The progress write stays outside
	// the transition so the next lesson never waits on it.
	const [isNavigating, startNavigation] = React.useTransition()

	const href =
		nextResource && moduleNavigation
			? nextResource.type === 'solution'
				? `/${pluralize(moduleType)}/${moduleNavigation.fields?.slug}/${resource?.fields?.slug}/solution`
				: `/${pluralize(moduleType)}/${moduleNavigation.fields?.slug}/${nextResource?.fields?.slug}`
			: null

	return (
		<Button
			className={cn(END_CARD_PRIMARY, 'cursor-pointer')}
			data-end-card-primary=""
			data-end-card-continue=""
			onClick={() => {
				// The lesson was completed when the video ended; this only
				// retries a write that failed and reverted. A problem lesson
				// completes on its solution instead.
				if (canRecordProgress && nextResource?.type !== 'solution') {
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
			Continue
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
	abilityLoader: AbilityLoader
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
	const action =
		overlayState.action?.type === 'COMPLETED' ? overlayState.action : null

	return (
		<AnimatePresence>
			{action && (
				<CompletedLessonOverlay
					key="end-card"
					action={action}
					resource={resource}
					moduleType={moduleType}
					moduleSlug={moduleSlug}
					abilityLoader={abilityLoader}
				/>
			)}
		</AnimatePresence>
	)
}

export default VideoPlayerOverlay
