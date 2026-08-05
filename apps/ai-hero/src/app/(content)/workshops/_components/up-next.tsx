'use client'

import React from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { TYPE } from '@/components/landing/type'
import { env } from '@/env.mjs'
import {
	findParentLessonForSolution,
	flattenNavigationResources,
} from '@/lib/content-navigation'
import { setProgressForResource } from '@/lib/progress'
import { getAdjacentWorkshopResources } from '@/utils/get-adjacent-workshop-resources'
import { ArrowRight } from 'lucide-react'
import { useSession } from 'next-auth/react'

import { cn } from '@coursebuilder/ui/utils/cn'
import type { AbilityForResource } from '@coursebuilder/utils/current-ability-rules'
import { getResourcePath } from '@coursebuilder/utils/resource-paths'

import { useModuleProgress } from '../../_components/module-progress-provider'
import { WorkshopCompleteCard } from './workshop-complete-card'
import { useWorkshopNavigation } from './workshop-navigation-provider'

// Component just for prefetching the next resource
function PrefetchNextResource({
	nextResource,
	workshopSlug,
}: {
	nextResource: { type: string; slug: string } | null
	workshopSlug: string | null
}) {
	const router = useRouter()

	React.useEffect(() => {
		if (!nextResource || !workshopSlug) return

		router.prefetch(
			getResourcePath(nextResource.type, nextResource.slug, 'view', {
				parentType: 'workshop',
				parentSlug: workshopSlug,
			}),
		)
	}, [router, nextResource, workshopSlug])

	return null
}

export default function UpNext({
	currentResourceId,
	className,
	abilityLoader,
}: {
	currentResourceId: string
	className?: string
	abilityLoader: Promise<
		Omit<AbilityForResource, 'canView'> & {
			canViewWorkshop: boolean
			canViewLesson: boolean
			isPendingOpenAccess: boolean
		}
	>
}) {
	const navigation = useWorkshopNavigation()
	const [isPending, startTransition] = React.useTransition()
	const { data: session } = useSession()
	const ability = React.use(abilityLoader)
	const canView = ability?.canViewLesson
	const { moduleProgress, addLessonProgress } = useModuleProgress()

	if (!navigation) {
		return null
	}

	const { nextResource } = getAdjacentWorkshopResources(
		navigation,
		currentResourceId,
	)

	// Helper function to check if a lesson has a solution
	const lessonHasSolution = (lessonId: string) => {
		if (!navigation?.resources) return false

		// Use flattenNavigationResources to get all resources, then find the lesson
		const flatResources = flattenNavigationResources(navigation)
		const lesson = flatResources.find(
			(r) => r.id === lessonId && r.type === 'lesson',
		)
		return (
			lesson?.type === 'lesson' &&
			lesson.resources &&
			lesson.resources.length > 0 &&
			lesson.resources.some((wrapper) => wrapper.resource?.type === 'solution')
		)
	}

	// Determine what should be completed and if we should complete anything
	const getCompletionLogic = () => {
		const parentLesson = findParentLessonForSolution(
			navigation,
			currentResourceId,
		)

		if (parentLesson) {
			// Current resource is a solution, complete the parent lesson
			return {
				shouldComplete: true,
				resourceToComplete: parentLesson.id,
				resourceSlugForRevalidation: parentLesson.fields?.slug,
			}
		}

		// Current resource is not a solution, check if it's a lesson
		if (!navigation?.resources) {
			return {
				shouldComplete: false,
				resourceToComplete: null,
				resourceSlugForRevalidation: null,
			}
		}

		// Use flattenNavigationResources to find the current resource
		const flatResources = flattenNavigationResources(navigation)
		const currentResource = flatResources.find(
			(r) => r.id === currentResourceId,
		)

		if (currentResource?.type === 'lesson') {
			if (lessonHasSolution(currentResourceId)) {
				// Lesson has a solution, don't complete it
				return {
					shouldComplete: false,
					resourceToComplete: null,
					resourceSlugForRevalidation: null,
				}
			} else {
				// Regular lesson without solution, complete normally
				return {
					shouldComplete: true,
					resourceToComplete: currentResourceId,
					resourceSlugForRevalidation: currentResource.fields?.slug,
				}
			}
		}

		// Fallback: don't complete
		return {
			shouldComplete: false,
			resourceToComplete: null,
			resourceSlugForRevalidation: null,
		}
	}

	const completionLogic = getCompletionLogic()

	const isCompleted = Boolean(
		moduleProgress?.completedLessons?.some(
			(p) =>
				p.resourceId ===
					(completionLogic.resourceToComplete || currentResourceId) &&
				p.completedAt,
		),
	)

	/**
	 * Marks this resource complete on the way out. Shared by both exits — the
	 * in-workshop "Up Next" link and the end-of-workshop handoff — because the
	 * last lesson of a workshop is exactly where progress used to stop being
	 * recorded: the component returned null before it could offer a click.
	 */
	const completeAndContinue = async () => {
		if (
			isCompleted ||
			!completionLogic.shouldComplete ||
			!completionLogic.resourceToComplete ||
			!canView
		) {
			return
		}

		const resourceToComplete = completionLogic.resourceToComplete
		startTransition(() => {
			addLessonProgress(resourceToComplete)
		})
		await setProgressForResource({
			resourceId: resourceToComplete,
			isCompleted: true,
		})
	}

	// End of the workshop. In a cohort that is a seam rather than an ending, so
	// hand off to the next workshop; standalone workshops render nothing, which
	// is what this whole component used to do in both cases.
	if (!nextResource) {
		return (
			<WorkshopCompleteCard
				className={className}
				onContinue={completeAndContinue}
			/>
		)
	}

	// For solution resources, we need to use the parent lesson's slug
	const nextResourceSlug =
		nextResource.type === 'solution'
			? findParentLessonForSolution(navigation, nextResource.id)?.fields
					?.slug || ''
			: nextResource.fields?.slug || ''

	const upNextText = lessonHasSolution(currentResourceId)
		? `View ${process.env.NEXT_PUBLIC_PARTNER_FIRST_NAME || 'Instructor'}'s Solution`
		: 'Up Next'

	return (
		<>
			<PrefetchNextResource
				nextResource={{
					type: nextResource.type || '',
					slug: nextResourceSlug,
				}}
				workshopSlug={navigation.fields?.slug || null}
			/>
			<nav
				className={cn(
					'bg-card mt-8 flex w-full flex-col items-center rounded border px-5 py-10 text-center',
					className,
				)}
				aria-label={upNextText}
			>
				{/* Same step as `WorkshopCompleteCard`'s heading: the two cards are
				    the same slot in the same place, and sizing them apart made the
				    end-of-workshop state read as a different kind of thing. */}
				<h2 className={cn(TYPE.panelTitle, 'mb-3')}>{upNextText}:</h2>
				<ul className="w-full">
					<li className="flex w-full flex-col">
						<Link
							className="text-primary flex w-full items-center justify-center gap-2 text-center text-lg hover:underline lg:text-xl"
							href={getResourcePath(
								nextResource.type || '',
								nextResourceSlug,
								'view',
								{
									parentType: 'workshop',
									parentSlug: navigation.fields?.slug || '',
								},
							)}
							onClick={completeAndContinue}
						>
							{nextResource.fields?.title || 'Next Resource'}
							<ArrowRight className="hidden w-4 sm:block" />
						</Link>
						{!session?.user && (
							<span className="text-muted-foreground mt-4">
								<Link
									href="/login"
									target="_blank"
									className="hover:text-foreground text-center underline"
								>
									Log in
								</Link>{' '}
								to save progress
							</span>
						)}
					</li>
				</ul>
			</nav>
		</>
	)
}
