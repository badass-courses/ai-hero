'use client'

import * as React from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { TYPE } from '@/components/landing/type'
import {
	getCohortWorkshopPosition,
	getNextCohortWorkshop,
	isWorkshopAvailable,
} from '@/lib/cohort-navigation'
import { formatCohortDateRange } from '@/utils/format-cohort-date'
import { ArrowRight, Check, Lock } from 'lucide-react'

import { Button } from '@coursebuilder/ui'
import { cn } from '@coursebuilder/ui/utils/cn'
import { getResourcePath } from '@coursebuilder/utils/resource-paths'

import {
	CohortCertificateAction,
	useCohortCertificateEligibility,
} from '../../_components/cohort-certificate-container'
import { useModuleProgress } from '../../_components/module-progress-provider'
import { useCohortNavigation } from './cohort-navigation-provider'
import { useWorkshopNavigation } from './workshop-navigation-provider'

/**
 * What a learner sees at the end of a workshop that belongs to a cohort.
 *
 * `UpNext` renders the next lesson *inside* a workshop; at the last lesson it
 * has nothing to point at and used to render nothing at all, which is the wall
 * this card removes. Cohorts are sold as one course and consumed as chapters,
 * so the end of a workshop is a seam, not an ending — the CTA goes straight to
 * the next workshop's first lesson rather than to its landing page, because
 * being bounced to an overview and made to pick again is the specific
 * complaint this answers.
 *
 * Renders nothing when the workshop has no cohort parent: a standalone
 * workshop really has ended, and inventing a destination would be a lie.
 */
export function WorkshopCompleteCard({
	className,
	onContinue,
}: {
	className?: string
	/**
	 * Marks the final lesson complete before navigating. Owned by `UpNext`,
	 * which already knows whether this resource is a solution, whether its
	 * parent lesson is the thing to complete, and whether the viewer may.
	 */
	onContinue?: () => void | Promise<void>
}) {
	const cohortNavigation = useCohortNavigation()
	const workshopId = useWorkshopNavigation()?.id ?? null
	const { moduleProgress } = useModuleProgress()
	const router = useRouter()

	const position = getCohortWorkshopPosition(cohortNavigation, workshopId)
	const nextWorkshop = getNextCohortWorkshop(cohortNavigation, workshopId)

	// Prefetch the destination for the same reason `UpNext` does: this click is
	// the most likely next navigation on the page.
	const nextHref = nextWorkshop
		? nextWorkshop.firstLesson
			? getResourcePath('lesson', nextWorkshop.firstLesson.slug, 'view', {
					parentType: 'workshop',
					parentSlug: nextWorkshop.slug,
				})
			: getResourcePath('workshop', nextWorkshop.slug, 'view')
		: null
	const isNextAvailable = nextWorkshop ? isWorkshopAvailable(nextWorkshop) : false

	React.useEffect(() => {
		if (nextHref && isNextAvailable) router.prefetch(nextHref)
	}, [router, nextHref, isNextAvailable])

	// Past the last workshop the card's action is the cohort certificate, once
	// the server confirms every workshop is done.
	const canClaimCohortCertificate = useCohortCertificateEligibility(
		nextWorkshop ? null : cohortNavigation,
	)

	if (!cohortNavigation) return null

	const isWorkshopComplete = Boolean(
		moduleProgress?.percentCompleted && moduleProgress.percentCompleted >= 100,
	)

	const cohortHref = getResourcePath('cohort', cohortNavigation.slug, 'view')

	const { dateString } = nextWorkshop
		? formatCohortDateRange(nextWorkshop.startsAt, null, nextWorkshop.timezone)
		: { dateString: null }

	const heading = nextWorkshop
		? `Up next: ${nextWorkshop.title}`
		: `That's the last workshop in ${cohortNavigation.title}`

	return (
		<nav
			className={cn(
				'bg-card mt-8 flex w-full flex-col items-center rounded border px-5 py-10 text-center',
				className,
			)}
			aria-label={heading}
		>
			{position && (
				<p
					className={cn(
						TYPE.metaMark,
						'mb-3 flex items-center justify-center gap-1.5',
					)}
				>
					{isWorkshopComplete && (
						<Check className="size-3.5 shrink-0" aria-hidden="true" />
					)}
					Workshop {position.index} of {position.total}
					{isWorkshopComplete ? ' complete' : ''}
				</p>
			)}
			<h2 className={cn(TYPE.panelTitle, 'text-balance')}>{heading}</h2>

			{nextWorkshop && isNextAvailable && nextHref && (
				<Button asChild size="lg" className="mt-6 w-full sm:w-auto">
					<Link
						href={nextHref}
						onClick={() => {
							void onContinue?.()
						}}
					>
						{nextWorkshop.firstLesson
							? `Start: ${nextWorkshop.firstLesson.title}`
							: 'Start this workshop'}
						<ArrowRight className="ml-2 hidden size-4 sm:block" />
					</Link>
				</Button>
			)}

			{!nextWorkshop && canClaimCohortCertificate && (
				<CohortCertificateAction
					cohort={cohortNavigation}
					className="bg-accent-fill text-accent-fill-foreground hover:bg-accent-fill-hover mt-6 h-11 w-full rounded-[9px] px-5 font-bold sm:w-auto"
				/>
			)}

			{nextWorkshop && !isNextAvailable && (
				<p
					className={cn(
						TYPE.meta,
						'text-muted-foreground mt-4 flex items-center justify-center gap-1.5',
					)}
				>
					<Lock className="size-3.5 shrink-0" aria-hidden="true" />
					{dateString ? `Unlocks ${dateString}` : 'Not released yet'}
				</p>
			)}

			<Link
				href={cohortHref}
				className={cn(
					TYPE.meta,
					'text-muted-foreground hover:text-foreground mt-6 underline underline-offset-4 transition-colors',
				)}
			>
				All workshops in {cohortNavigation.title}
			</Link>
		</nav>
	)
}
