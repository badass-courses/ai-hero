'use client'

import * as React from 'react'
import Link from 'next/link'
import { useWorkshopNavigation } from '@/app/(content)/workshops/_components/workshop-navigation-provider'
import Spinner from '@/components/spinner'
import { getFirstResourceSlug } from '@/lib/content-navigation'
import { MinimalWorkshop } from '@/lib/workshops'
import { formatInTimeZone } from 'date-fns-tz'
import { Github } from 'lucide-react'

import type { ProductType } from '@coursebuilder/core/schemas'
import { Button } from '@coursebuilder/ui'
import { cn } from '@coursebuilder/ui/utils/cn'
import type { AbilityForResource } from '@coursebuilder/utils/current-ability-rules'

import { useModuleProgress } from '../../_components/module-progress-provider'
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
	abilityLoader,
	moduleSlug,
	className,
	workshop,
}: {
	productType?: ProductType
	abilityLoader: Promise<
		Omit<AbilityForResource, 'canView'> & {
			canViewWorkshop: boolean
			canViewLesson: boolean
			isPendingOpenAccess: boolean
		}
	>
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
	const { canViewWorkshop: canView, isPendingOpenAccess } =
		React.use(abilityLoader)

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
				<span className="text-foreground font-mono text-[13px] font-medium">
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

export function GetAccessButton({
	abilityLoader,
	className,
}: {
	abilityLoader: Promise<
		Omit<AbilityForResource, 'canView'> & {
			canViewWorkshop: boolean
			canViewLesson: boolean
			isPendingOpenAccess: boolean
		}
	>
	className?: string
}) {
	const { canViewWorkshop: canView } = React.use(abilityLoader)
	const workshopNavigation = useWorkshopNavigation()

	const cohortProduct =
		workshopNavigation?.parents?.[0]?.type === 'cohort' &&
		workshopNavigation?.parents?.[0]

	const cohortSlug =
		cohortProduct && cohortProduct?.resources?.[0]?.resource?.fields?.slug

	if (canView || !cohortSlug) return null

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

export function WorkshopGitHubRepoLink({
	githubUrl,
	abilityLoader,
}: {
	githubUrl?: string
	abilityLoader: Promise<
		Omit<AbilityForResource, 'canView'> & {
			canViewWorkshop: boolean
			canViewLesson: boolean
			isPendingOpenAccess: boolean
		}
	>
}) {
	const { canViewWorkshop: canView } = React.use(abilityLoader)
	if (!githubUrl) return null
	if (!canView) return null
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
