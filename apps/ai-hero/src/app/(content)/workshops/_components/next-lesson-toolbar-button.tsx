'use client'

import Link from 'next/link'
import {
	getNextCohortWorkshop,
	isWorkshopAvailable,
} from '@/lib/cohort-navigation'
import { findParentLessonForSolution } from '@/lib/content-navigation'
import { getAdjacentWorkshopResources } from '@/utils/get-adjacent-workshop-resources'
import { ArrowRight } from 'lucide-react'

import { Button } from '@coursebuilder/ui'
import { getResourcePath } from '@coursebuilder/utils/resource-paths'

import { useCohortNavigation } from './cohort-navigation-provider'
import { useWorkshopNavigation } from './workshop-navigation-provider'

export function NextLessonToolbarButton({
	lessonId,
	moduleSlug,
}: {
	lessonId: string
	moduleSlug: string
}) {
	const workshopNavigation = useWorkshopNavigation()
	const cohortNavigation = useCohortNavigation()
	const { nextResource } = getAdjacentWorkshopResources(
		workshopNavigation,
		lessonId,
	)

	// A solution is routed under its parent LESSON's slug, so resolve that the
	// same way `UpNext` does — building `/workshops/{module}/{solutionSlug}`
	// from the raw slug, as this button used to, is a 404.
	const nextResourceSlug =
		nextResource?.type === 'solution'
			? findParentLessonForSolution(workshopNavigation, nextResource.id)?.fields
					?.slug
			: nextResource?.fields?.slug

	// Past the last lesson of a workshop, "next" continues into the cohort's
	// next workshop rather than disappearing — same rule as the end-of-workshop
	// card below the player, so the two never disagree about where next is.
	//
	// Gated on `!nextResource`, NOT on the resolved slug: a resource that exists
	// but whose slug we could not resolve still means there is more of THIS
	// workshop to come, and advertising the next workshop there would skip it.
	// That case renders nothing, exactly as it did before.
	const nextWorkshop = nextResource
		? null
		: getNextCohortWorkshop(cohortNavigation, workshopNavigation?.id)

	const target = nextResourceSlug
		? {
				label: 'Next lesson',
				href: getResourcePath(
					nextResource?.type || 'lesson',
					nextResourceSlug,
					'view',
					{ parentType: 'workshop', parentSlug: moduleSlug },
				),
			}
		: nextWorkshop &&
			  nextWorkshop.firstLesson &&
			  isWorkshopAvailable(nextWorkshop)
			? {
					label: 'Next workshop',
					href: getResourcePath(
						'lesson',
						nextWorkshop.firstLesson.slug,
						'view',
						{ parentType: 'workshop', parentSlug: nextWorkshop.slug },
					),
				}
			: null

	if (!target) return null

	return (
		<Button
			asChild
			variant="outline"
			className="hover:bg-muted/50 border-l-border h-10 rounded-none border-0 border-l bg-transparent sm:h-12"
		>
			<Link href={target.href} prefetch>
				{target.label}
				<ArrowRight className="text-muted-foreground ml-2 h-4 w-4" />
			</Link>
		</Button>
	)
}
