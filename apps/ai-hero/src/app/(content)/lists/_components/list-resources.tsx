'use client'

import * as React from 'react'

import type { ContentResourceResource } from '@coursebuilder/core/schemas'

import { ResourceListView } from '../../_components/resource-list-view'
import { useProgress } from '../../[post]/_components/progress-provider'

/**
 * The list landing's "Content" sidebar. Renders through the shared
 * `ResourceListView` — the same section-aware component the workshop sidebar
 * uses — so any list (sectioned or flat) matches workshops across the board.
 * `resources` is the deep, visibility-filtered tree built server-side; a
 * `section` row carries its children and renders as a collapsible group.
 */
export default function ListResources({
	resources,
	title,
	titleHref,
	moduleId,
}: {
	resources: ContentResourceResource[]
	title: string
	titleHref: string
	moduleId: string
}) {
	const { progress } = useProgress()

	if (!resources || resources.length === 0) {
		return null
	}

	return (
		<aside className="md:bg-muted col-span-2 border-l dark:md:bg-transparent">
			<ResourceListView
				title={title}
				titleHref={titleHref}
				moduleId={moduleId}
				resources={resources}
				completedLessons={progress?.completedLessons}
				// List items are posts served at the site root.
				buildLessonHref={(slug) => `/${slug}`}
				withHeader={false}
				showAutoplay={false}
				isCollapsible={false}
				className="w-full max-w-none border-r-0"
				maxHeight="h-auto"
			/>
		</aside>
	)
}
