'use client'

import * as React from 'react'
import { useParams, usePathname } from 'next/navigation'
import { createAppAbility } from '@/ability'
import { useModuleProgress } from '@/app/(content)/_components/module-progress-provider'
import { useWorkshopNavigation } from '@/app/(content)/workshops/_components/workshop-navigation-provider'
import { getCohortFromNavigation } from '@/lib/cohort-navigation'
import { findSectionIdForResourceSlug } from '@/lib/content-navigation'
import { api } from '@/trpc/react'

import { getResourcePath } from '@coursebuilder/utils/resource-paths'

import { ResourceListView } from '../../_components/resource-list-view'

type Props = {
	currentLessonSlug?: string
	currentSectionSlug?: string | null
	className?: string
	wrapperClassName?: string
	maxHeight?: string
	withHeader?: boolean
	isCollapsible?: boolean
}

export function WorkshopResourceList(props: Props) {
	const wrapperClassName = props.wrapperClassName ?? ''
	const className = props.className ?? ''
	const withHeader = props.withHeader ?? true
	const maxHeight = props.maxHeight ?? 'h-[calc(100vh-var(--nav-height))]'
	const isCollapsible = props.isCollapsible ?? true

	const workshopNavigation = useWorkshopNavigation()
	const { moduleProgress } = useModuleProgress()
	const params = useParams()
	const pathname = usePathname()

	const { data: abilityRules, status: abilityStatus } =
		api.ability.getCurrentAbilityRules.useQuery(
			{
				moduleId: workshopNavigation?.id,
				lessonId: props.currentLessonSlug,
			},
			{
				enabled: !!workshopNavigation?.id,
			},
		)

	const ability = createAppAbility(abilityRules || [])

	const sectionId = findSectionIdForResourceSlug(
		workshopNavigation,
		props.currentLessonSlug,
	)

	if (!workshopNavigation) {
		return null
	}

	const { resources, setIsSidebarCollapsed, isSidebarCollapsed } =
		workshopNavigation

	const cohort = getCohortFromNavigation(workshopNavigation)

	const moduleSlug = String(
		params.module ?? workshopNavigation.fields?.slug ?? '',
	)

	return (
		<ResourceListView
			title={workshopNavigation.fields?.title ?? ''}
			titleHref={`/workshops/${workshopNavigation.fields?.slug}`}
			breadcrumb={{
				label: cohort?.title ?? 'Workshops',
				href: cohort
					? getResourcePath('cohort', cohort.slug, 'view')
					: '/posts?type=workshop',
			}}
			moduleId={workshopNavigation.id}
			resources={resources ?? undefined}
			defaultOpenSectionId={sectionId}
			currentSlug={props.currentLessonSlug}
			isOnSolution={pathname.includes('/solution')}
			completedLessons={moduleProgress?.completedLessons}
			buildLessonHref={(slug) => `/workshops/${moduleSlug}/${slug}`}
			buildEditHref={(slug) => `/workshops/${moduleSlug}/${slug}/edit`}
			ability={ability}
			abilityStatus={abilityStatus}
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
