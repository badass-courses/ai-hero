'use client'

import Link from 'next/link'
import { useWorkshopNavigation } from '@/app/(content)/workshops/_components/workshop-navigation-provider'
import { TYPE } from '@/components/landing/type'
import { Share } from '@/components/share'
import Spinner from '@/components/spinner'
import { getFirstResourceSlug } from '@/lib/content-navigation'
import { MinimalWorkshop } from '@/lib/workshops'
import { formatInTimeZone } from 'date-fns-tz'
import { Github, Share2 } from 'lucide-react'

import type { ProductType } from '@coursebuilder/core/schemas'
import {
	Button,
	Dialog,
	DialogContent,
	DialogTitle,
	DialogTrigger,
} from '@coursebuilder/ui'
import { cn } from '@coursebuilder/ui/utils/cn'

import { useModuleProgress } from '../../_components/module-progress-provider'
import { useWorkshopAbility } from './use-workshop-ability'
import { WORKSHOP_CTA_BUTTON } from './workshop-notify-button'

/**
 * The actions bar's secondary control: same 46px/9px geometry as the primary
 * CTA (`WORKSHOP_CTA_BUTTON`), drawn as a hairline outline instead of a fill —
 * one gold object per bar, everything else recedes (DESIGN rule 7).
 */
const ACTIONS_BAR_OUTLINE =
	'border-border h-[46px] items-center gap-2 rounded-[9px] border bg-transparent px-[18px] text-sm font-medium'

export function StartLearningWorkshopButton({
	productType,
	moduleSlug,
	className,
	workshop,
}: {
	productType?: ProductType
	moduleSlug: string
	className?: string
	workshop: MinimalWorkshop
}) {
	const workshopNavigation = useWorkshopNavigation()
	const firstLessonSlug = getFirstResourceSlug(workshopNavigation)
	const { moduleProgress } = useModuleProgress()
	const isWorkshopInProgress =
		moduleProgress?.nextResource?.fields?.slug &&
		moduleProgress?.completedLessons?.length > 0

	const url = isWorkshopInProgress
		? `/workshops/${moduleSlug}/${moduleProgress?.nextResource?.fields?.slug}`
		: `/workshops/${moduleSlug}/${firstLessonSlug}`
	const {
		canViewWorkshop: canView,
		isPendingOpenAccess,
		status,
	} = useWorkshopAbility()

	if (status !== 'success') return <StartLearningWorkshopButtonSkeleton />

	if (isPendingOpenAccess && workshop?.fields?.startsAt) {
		const formattedDate = formatInTimeZone(
			new Date(workshop?.fields?.startsAt || ''),
			'America/Los_Angeles',
			`MMM d, yyyy 'at' h:mm a`,
		)

		return (
			<span
				className={cn(
					ACTIONS_BAR_OUTLINE,
					'text-muted-foreground inline-flex cursor-not-allowed select-none',
					className,
				)}
			>
				Available{' '}
				<span className={cn(TYPE.metaMono, 'text-foreground font-medium')}>
					{formattedDate} (PT)
				</span>
			</span>
		)
	}

	if (productType === 'cohort') {
		// preview not available
		return null
	}

	if (!canView) {
		return null
	}

	// No resolvable lesson means the link would point at `/null` — hide it until
	// the workshop actually has content.
	if (!isWorkshopInProgress && !firstLessonSlug) {
		return null
	}

	return (
		<Button size="lg" className={cn(WORKSHOP_CTA_BUTTON, className)} asChild>
			<Link prefetch href={url}>
				{!moduleProgress && 'Loading...'}
				{moduleProgress && (
					<>{isWorkshopInProgress ? 'Continue Learning' : 'Start Learning'}</>
				)}
			</Link>
		</Button>
	)
}

export function GetAccessButton({ className }: { className?: string }) {
	const { canViewWorkshop: canView, status } = useWorkshopAbility()
	const workshopNavigation = useWorkshopNavigation()

	const cohortProduct =
		workshopNavigation?.parents?.[0]?.type === 'cohort' &&
		workshopNavigation?.parents?.[0]

	const cohortSlug =
		cohortProduct && cohortProduct?.resources?.[0]?.resource?.fields?.slug

	if (status !== 'success' || canView || !cohortSlug) return null

	return (
		<Button size="lg" className={cn(WORKSHOP_CTA_BUTTON, className)} asChild>
			<Link prefetch href={`/cohorts/${cohortSlug}`}>
				Get Access
			</Link>
		</Button>
	)
}

export function StartLearningWorkshopButtonSkeleton() {
	return (
		<span
			className={cn(
				ACTIONS_BAR_OUTLINE,
				'text-muted-foreground inline-flex select-none',
			)}
			aria-busy="true"
		>
			<Spinner className="size-3.5" /> Checking your access...
		</span>
	)
}

/**
 * The actions bar (`Workshop Landing.dc.html` § "Actions bar"): free-standing
 * 46px/9px controls in a padded hairline-bounded row, one gold object at a
 * time. It gates its own existence on the same conditions its buttons check —
 * an empty bar (a waitlist visitor: no access, nothing pending, no repo) is no
 * bar at all, not a hairline-bounded row of padding around Share. Ability
 * resolves on the client (the page shell is static), so the decision lives
 * here rather than on the server.
 */
export function WorkshopActionsBar({
	workshop,
	moduleSlug,
	productType,
	variant = 'top',
}: {
	workshop: MinimalWorkshop
	moduleSlug: string
	productType?: ProductType
	/** `bottom` repeats the bar after the article, wrapped in its own grid row. */
	variant?: 'top' | 'bottom'
}) {
	const {
		canViewWorkshop: canView,
		isPendingOpenAccess,
		status,
	} = useWorkshopAbility()
	const workshopNavigation = useWorkshopNavigation()
	const hasContent = Boolean(getFirstResourceSlug(workshopNavigation))
	const cohortParent =
		workshopNavigation?.parents?.[0]?.type === 'cohort'
			? workshopNavigation.parents[0]
			: null
	const cohortSlug = cohortParent?.resources?.[0]?.resource?.fields?.slug

	const hasBarActions = Boolean(
		(isPendingOpenAccess && workshop.fields?.startsAt) ||
			(canView && productType !== 'cohort' && hasContent) ||
			(!canView && cohortSlug) ||
			(canView && workshop.fields?.github),
	)
	if (status !== 'success' || !hasBarActions) return null

	const bar = (
		<div
			className={cn(
				'flex w-full flex-wrap items-center gap-2.5 border-b px-5 py-2.5 sm:px-8 lg:px-10',
				variant === 'bottom' && 'border-b-0',
			)}
		>
			<GetAccessButton className="w-full sm:w-auto" />
			<StartLearningWorkshopButton
				className="w-full sm:w-auto"
				productType={productType}
				moduleSlug={moduleSlug}
				workshop={workshop}
			/>
			{workshop.fields?.github ? (
				<WorkshopGitHubRepoLink githubUrl={workshop.fields.github} />
			) : null}
			<Dialog>
				<DialogTrigger asChild>
					<Button
						className={cn(
							TYPE.meta,
							'text-muted-foreground hover:text-foreground hover:bg-muted h-[46px] rounded-[9px] px-4',
						)}
						variant="ghost"
						size="lg"
					>
						<Share2 className="mr-1 size-3.5" /> Share
					</Button>
				</DialogTrigger>
				<DialogContent
					lockScroll={false}
					className="max-w-[min(640px,calc(100vw-2rem))] gap-0 overflow-hidden rounded-[12px] p-0"
				>
					<DialogTitle className={cn(TYPE.subhead, 'border-b px-6 py-5')}>
						Share
					</DialogTitle>
					<Share
						variant="dialog"
						title={workshop.fields?.title}
						className="p-6"
					/>
				</DialogContent>
			</Dialog>
		</div>
	)

	if (variant === 'bottom') {
		// The bar again at the end of the read — same object, so a reader who
		// finished the argument doesn't scroll back up to act on it. The empty
		// sidebar cell keeps the column hairline running.
		return (
			<div className="grid-cols-6 border-t md:grid">
				<div className="col-span-4">{bar}</div>
				<div
					className="col-span-2 hidden border-l md:block"
					aria-hidden="true"
				/>
			</div>
		)
	}
	return bar
}

export function WorkshopGitHubRepoLink({ githubUrl }: { githubUrl?: string }) {
	const { canViewWorkshop: canView, status } = useWorkshopAbility()
	if (!githubUrl) return null
	if (status !== 'success' || !canView) return null
	return (
		<Button
			asChild
			size="lg"
			variant="outline"
			className={cn(ACTIONS_BAR_OUTLINE, 'text-foreground hover:bg-muted flex')}
		>
			<Link href={githubUrl} target="_blank" rel="noopener noreferrer">
				<Github className="size-4" /> Code
			</Link>
		</Button>
	)
}
