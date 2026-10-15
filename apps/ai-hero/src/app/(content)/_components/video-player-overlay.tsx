'use client'

import React, { use } from 'react'
import { flushSync } from 'react-dom'
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
import { api } from '@/trpc/react'
import { getAdjacentWorkshopResources } from '@/utils/get-adjacent-workshop-resources'
import type { AbilityForResource } from '@/utils/get-current-ability-rules'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { ArrowRight } from 'lucide-react'
import { useSession } from 'next-auth/react'
import { useReward } from 'react-rewards'

import type { ContentResource } from '@coursebuilder/core/schemas'
import { Button, Progress } from '@coursebuilder/ui'
import { useVideoPlayerOverlay } from '@coursebuilder/ui/hooks/use-video-player-overlay'
import { cn } from '@coursebuilder/ui/utils/cn'
import { getResourcePath } from '@coursebuilder/utils/resource-paths'

import { CopyProblemPromptButton } from '../workshops/_components/copy-problem-prompt-button'
import * as ModuleCertificate from '@/components/certificates/module-certificate'

import { completeLessonInBackground } from './complete-lesson-in-background'
import {
	CohortCertificateAction,
	useCohortCertificateEligibility,
} from './cohort-certificate-container'
import {
	AUTO_ADVANCE_SECONDS,
	EndCard,
	END_CARD_SECONDARY,
	EndCardItem,
	type EndCardAction,
} from './end-card'
import { CertificateDialog } from './module-certificate-container'
import { useModuleProgress } from './module-progress-provider'
import { getNextLesson, type NextLesson } from './next-lesson'

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

/** Ticks down from AUTO_ADVANCE_SECONDS while `active`, then calls `onDone`. */
function useCountdown(active: boolean, onDone: () => void) {
	const [secondsLeft, setSecondsLeft] = React.useState(AUTO_ADVANCE_SECONDS)
	const onDoneRef = React.useRef(onDone)
	React.useLayoutEffect(() => {
		onDoneRef.current = onDone
	})

	React.useEffect(() => {
		if (!active) return
		const startedAt = Date.now()
		const timer = setInterval(() => {
			const left =
				AUTO_ADVANCE_SECONDS - (Date.now() - startedAt) / 1000
			setSecondsLeft(Math.max(0, Math.ceil(left)))
			if (left > 0) return
			clearInterval(timer)
			onDoneRef.current()
		}, 100)
		return () => clearInterval(timer)
	}, [active])

	return secondsLeft
}

/** Drains linearly over the countdown; reduced motion keeps the number only. */
function CountdownTrack() {
	const reduceMotion = useReducedMotion()
	if (reduceMotion) return null
	return (
		<div className="h-1 w-[150px] overflow-hidden rounded-full bg-white/20 sm:w-[200px]">
			<motion.div
				className="bg-accent-fill h-full origin-left"
				initial={{ scaleX: 1 }}
				animate={{ scaleX: 0 }}
				transition={{ duration: AUTO_ADVANCE_SECONDS, ease: 'linear' }}
			/>
		</div>
	)
}

/**
 * Moves on to the next lesson. The progress write (a retry; the ended handler
 * already wrote it) starts before the push and stays outside the transition,
 * which only drives the spinner.
 */
function useContinue({
	resource,
	prevResource,
	next,
	canRecordProgress,
	hasSession,
}: {
	resource: ContentResource | null
	prevResource: ContentResource | null
	next: NextLesson | null
	canRecordProgress: boolean
	hasSession: boolean
}) {
	const router = useRouter()
	const pathname = usePathname()
	const { moduleProgress, addLessonProgress, removeLessonProgress } =
		useModuleProgress()
	// tRPC, not a server action: one settling during the push below would
	// replay this page over the next one.
	const { client } = api.useUtils()
	const [isNavigating, startNavigation] = React.useTransition()

	const go = () => {
		// A problem lesson completes on its solution instead.
		if (resource && canRecordProgress && !next?.isSolution) {
			// On a solution, the lesson to complete is the problem before it.
			const isSolution = pathname.endsWith('/solution')
			void completeLessonInBackground({
				resourceId: isSolution && prevResource ? prevResource.id : resource.id,
				moduleProgress,
				addLessonProgress,
				removeLessonProgress,
				setCompleted: client.progress.setCompleted.mutate,
				optimistic: hasSession,
			})
		}
		if (next) startNavigation(() => router.push(next.href))
	}

	return { go, isNavigating }
}

export const CompletedLessonOverlay: React.FC<{
	action: EndCardAction
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
	const { dispatch } = useVideoPlayerOverlay()
	const workshopNavigation = useWorkshopNavigation()
	const { nextResource: adjacentNextLesson, prevResource: prevLesson } =
		getAdjacentWorkshopResources(workshopNavigation, resource?.id as string)
	const next = getNextLesson({
		navigation: workshopNavigation,
		next: action.nextResource || adjacentNextLesson,
		moduleType,
	})

	const { moduleProgress } = useModuleProgress()
	const { data: session } = useSession()
	// A cookie-only email-course subscriber has no session but is recorded.
	const canRecordProgress = use(abilityLoader).canViewLesson
	const { go, isNavigating } = useContinue({
		resource,
		prevResource: prevLesson,
		next,
		canRecordProgress,
		hasSession: Boolean(session?.user),
	})

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

	const counting = Boolean(action.autoAdvance && next && !isModuleComplete)
	const secondsLeft = useCountdown(counting, go)

	if (!next || isModuleComplete)
		return (
			<CompletedModuleOverlay
				action={action}
				moduleType={moduleType}
				moduleSlug={moduleSlug}
			/>
		)

	const partner = process.env.NEXT_PUBLIC_PARTNER_FIRST_NAME || 'Instructor'
	const label = next.isSolution
		? counting
			? `${partner}'s solution in`
			: `Now watch ${partner}'s solution`
		: counting
			? 'Up next in'
			: 'Up next'

	const cancel = () => {
		// Becomes the normal card; keep the keyboard on it.
		const normalCard: EndCardAction = { ...action, autoAdvance: false }
		flushSync(() => dispatch(normalCard))
		document
			.querySelector<HTMLElement>('[data-end-card-continue]')
			?.focus({ preventScroll: true })
	}

	return (
		<EndCard>
			<EndCardItem className="flex flex-col items-center gap-3">
				{next.thumbnailUrl && (
					// The same immutable URL the player preloads at 80%. Only drawn
					// where the card has the height for it.
					// eslint-disable-next-line @next/next/no-img-element
					<img
						src={next.thumbnailUrl}
						alt=""
						className="hidden aspect-video w-40 rounded-[9px] object-cover ring-1 ring-white/15 sm:w-48 [@container(min-height:22rem)]:block"
					/>
				)}
				<div>
					<p className={cn(TYPE.meta, 'pb-1 text-white/70')}>
						{label}
						{counting && (
							<span className="tabular-nums text-white"> {secondsLeft}</span>
						)}
						{next.number && (
							<span className="text-white/50">
								{' '}
								· Lesson {next.number} of {next.total}
							</span>
						)}
					</p>
					<p className={TYPE.subhead}>{next.title}</p>
				</div>
			</EndCardItem>
			<EndCardItem>
				{counting ? (
					<CountdownTrack />
				) : session?.user ? (
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
				{counting ? (
					<Button
						variant="ghost"
						type="button"
						className={END_CARD_SECONDARY}
						onClick={cancel}
					>
						Cancel
					</Button>
				) : (
					<>
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
					</>
				)}
				<Button
					className={cn(END_CARD_PRIMARY, 'cursor-pointer')}
					data-end-card-primary=""
					data-end-card-continue=""
					onClick={go}
					type="button"
					disabled={isNavigating}
				>
					{counting ? 'Play now' : 'Continue'}
					{isNavigating ? (
						<Spinner className="ml-2 size-4" />
					) : (
						<ArrowRight className="ml-2 size-4" />
					)}
				</Button>
			</EndCardItem>
		</EndCard>
	)
}

/**
 * The workshop is done. The lesson was already marked complete when the video
 * ended (see `AuthedVideoPlayer`), so this card only celebrates and points on.
 */
export const CompletedModuleOverlay: React.FC<{
	action: EndCardAction
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
