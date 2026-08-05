'use client'

import Link from 'next/link'
import { getCohortFromNavigation } from '@/lib/cohort-navigation'

import { getResourcePath } from '@coursebuilder/utils/resource-paths'

import { useWorkshopNavigation } from './workshop-navigation-provider'

export default function WorkshopBreadcrumb() {
	const navigation = useWorkshopNavigation()
	const cohort = getCohortFromNavigation(navigation)

	if (!cohort) return null

	return (
		<div className="flex items-center gap-2">
			<Link
				className="text-primary block min-w-0 max-w-[300px] flex-1 truncate sm:max-w-full"
				href={getResourcePath('cohort', cohort.slug, 'view')}
			>
				{cohort.title}
			</Link>
			<span className="opacity-50">/</span>
		</div>
	)
}
