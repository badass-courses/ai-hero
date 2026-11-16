'use client'

import * as React from 'react'
import { useParams, usePathname } from 'next/navigation'
import { createAppAbility, type AppAbility } from '@/ability'
import { useModuleProgress } from '@/app/(content)/_components/module-progress-provider'
import { useWorkshopNavigation } from '@/app/(content)/workshops/_components/workshop-navigation-provider'
import {
	getCohortFromNavigation,
	getCohortWorkshopPosition,
	getNextCohortWorkshop,
	isWorkshopAvailable,
} from '@/lib/cohort-navigation'
import {
	findSectionIdForResourceSlug,
	type ResourceNavigation,
} from '@/lib/content-navigation'
import {
	getWorkshopResourceHref,
	type CourseResource,
} from '@/lib/course-resume-navigation'
import { api } from '@/trpc/react'
import { formatCohortDateRange } from '@/utils/format-cohort-date'
import type { RawRuleOf } from '@casl/ability'
import { useSession } from 'next-auth/react'

import { getResourcePath } from '@coursebuilder/utils/resource-paths'

import {
	ResourceListView,
	type NextModuleLink,
} from '../../_components/resource-list-view'
import { useCohortNavigation } from './cohort-navigation-provider'

type Props = {
	currentSectionSlug?: string | null
	className?: string
	wrapperClassName?: string
	maxHeight?: string
	withHeader?: boolean
	isCollapsible?: boolean
	/** Render every section collapsed instead of opening the first/current one. */
	defaultAllClosed?: boolean
}

const freeLessonTypes = new Set(['lesson', 'exercise', 'post'])

/** Recreates only the public `tier: free` rules from the cached nav tree. */
export function getAnonymousWorkshopAbilityRules(
	workshopNavigation: ResourceNavigation | null,
): RawRuleOf<AppAbility>[] {
	const freeResourceIds: string[] = []

	for (const wrapper of workshopNavigation?.resources ?? []) {
		if (wrapper.metadata?.tier !== 'free') continue

		if (wrapper.resource.type === 'section') {
			for (const child of wrapper.resource.resources ?? []) {
				if (freeLessonTypes.has(child.resource.type)) {
					freeResourceIds.push(child.resource.id)
				}
			}
		} else if (freeLessonTypes.has(wrapper.resource.type)) {
			freeResourceIds.push(wrapper.resource.id)
		}
	}

	return freeResourceIds.length
		? [
				{
					action: 'read',
					subject: 'Content',
					conditions: { id: { $in: freeResourceIds } },
				},
			]
		: []
}

/** The shared list renders section children as rows, not recursive sections. */
export function getWorkshopListResources(navigation: ResourceNavigation) {
	const hrefs = new Map<string, string>()
	type Wrappers = NonNullable<ResourceNavigation['resources']>
	type Wrapper = {
		resource: CourseResource
		metadata?: Record<string, unknown> | null
	}
	function rows(wrappers: Wrapper[], insideSection = false): Wrapper[] {
		return wrappers.flatMap((wrapper): Wrapper[] => {
			const { resource } = wrapper
			if (resource.type === 'section') {
				const children = rows(
					(resource.resources ?? []).filter((child): child is Wrapper =>
						Boolean(child.resource),
					),
					true,
				)
				// Nested sections have no page. Keep their playable rows under the
				// enclosing heading rather than handing a section to LessonResource.
				return insideSection
					? children
					: [{ ...wrapper, resource: { ...resource, resources: children } }]
			}
			const href = getWorkshopResourceHref(navigation, resource)
			const slug = resource.fields?.slug
			if (!href || typeof slug !== 'string' || !slug) return []
			hrefs.set(slug, href)
			return [{ ...wrapper, resource }]
		})
	}
	// All relation/resource fields survive the spreads; only nesting is reduced.
	return { resources: rows(navigation.resources ?? []) as Wrappers, hrefs }
}

export function WorkshopResourceList(props: Props) {
	const wrapperClassName = props.wrapperClassName ?? ''
	const className = props.className ?? ''
	const withHeader = props.withHeader ?? true
	const maxHeight = props.maxHeight ?? 'h-[calc(100vh-var(--nav-height))]'
	const isCollapsible = props.isCollapsible ?? true

	const workshopNavigation = useWorkshopNavigation()
	const cohortNavigation = useCohortNavigation()
	const { moduleProgress } = useModuleProgress()
	const params = useParams()
	// From the URL, not a prop: the lesson layout that renders this list stays
	// mounted while the lesson changes underneath it.
	const currentLessonSlug =
		typeof params.lesson === 'string' ? params.lesson : undefined
	const pathname = usePathname()
	const { status: sessionStatus } = useSession()
	const isAnonymousShell = sessionStatus !== 'authenticated'

	const { data: abilityRules, status: abilityStatus } =
		api.ability.getCurrentAbilityRules.useQuery(
			{
				moduleId: workshopNavigation?.id,
				lessonId: currentLessonSlug,
			},
			{
				enabled: sessionStatus === 'authenticated' && !!workshopNavigation?.id,
			},
		)

	const ability = createAppAbility(
		isAnonymousShell
			? getAnonymousWorkshopAbilityRules(workshopNavigation)
			: abilityRules || [],
	)

	const sectionId = findSectionIdForResourceSlug(
		workshopNavigation,
		currentLessonSlug,
	)

	if (!workshopNavigation) {
		return null
	}

	const { setIsSidebarCollapsed, isSidebarCollapsed } = workshopNavigation
	const { resources, hrefs } = getWorkshopListResources(workshopNavigation)

	const cohort = getCohortFromNavigation(workshopNavigation)

	// Where this workshop sits in its cohort, and what follows it. Both are
	// null for a standalone workshop, which then renders exactly as before.
	const position = getCohortWorkshopPosition(
		cohortNavigation,
		workshopNavigation.id,
	)
	const nextWorkshop = getNextCohortWorkshop(
		cohortNavigation,
		workshopNavigation.id,
	)
	const isNextAvailable = nextWorkshop
		? isWorkshopAvailable(nextWorkshop)
		: false
	const nextModule: NextModuleLink | undefined = nextWorkshop
		? {
				title: nextWorkshop.title,
				// An available workshop goes straight to its first lesson; without
				// one there is nothing to play, so its overview is the honest target.
				href:
					isNextAvailable && nextWorkshop.firstLesson
						? getResourcePath('lesson', nextWorkshop.firstLesson.slug, 'view', {
								parentType: 'workshop',
								parentSlug: nextWorkshop.slug,
							})
						: getResourcePath('workshop', nextWorkshop.slug, 'view'),
				locked: !isNextAvailable,
				unlocksAt: formatCohortDateRange(
					nextWorkshop.startsAt,
					null,
					nextWorkshop.timezone,
				).dateString,
			}
		: undefined

	return (
		<ResourceListView
			title={workshopNavigation.fields?.title ?? ''}
			titleHref={
				getWorkshopResourceHref(workshopNavigation, workshopNavigation) ??
				'/posts?type=workshop'
			}
			breadcrumb={{
				label: cohort?.title ?? 'Workshops',
				href: cohort
					? getResourcePath('cohort', cohort.slug, 'view')
					: '/posts?type=workshop',
			}}
			positionLabel={
				position ? `Workshop ${position.index} of ${position.total}` : undefined
			}
			nextModule={nextModule}
			moduleId={workshopNavigation.id}
			resources={resources ?? undefined}
			defaultOpenSectionId={props.defaultAllClosed ? null : sectionId}
			defaultAllClosed={props.defaultAllClosed}
			currentSlug={currentLessonSlug}
			isOnSolution={pathname.includes('/solution')}
			completedLessons={moduleProgress?.completedLessons}
			buildLessonHref={(slug) => hrefs.get(slug) ?? '#'}
			buildEditHref={(slug) =>
				hrefs.has(slug) ? `${hrefs.get(slug)}/edit` : '#'
			}
			ability={ability}
			abilityStatus={isAnonymousShell ? 'success' : abilityStatus}
			isCollapsible={isCollapsible}
			isCollapsed={isSidebarCollapsed}
			onToggleCollapse={setIsSidebarCollapsed}
			withHeader={withHeader}
			showAutoplay
			className={className}
			wrapperClassName={wrapperClassName}
			maxHeight={maxHeight}
		/>
	)
}
