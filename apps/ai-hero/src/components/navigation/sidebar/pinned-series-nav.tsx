'use client'

import * as React from 'react'
import Link from 'next/link'
import { useList } from '@/app/(content)/[post]/_components/list-provider'
import { useProgress } from '@/app/(content)/[post]/_components/progress-provider'

import {
	SidebarGroup,
	SidebarGroupLabel,
	SidebarSeparator,
} from '@coursebuilder/ui'

import { SeriesLessons } from './series-lessons'

const CATEGORY_LABEL_CLASS =
	'text-muted-foreground h-auto px-2 pb-1 pt-5 text-[11px] font-semibold uppercase tracking-wider'

/**
 * "In this series" group pinned to the TOP of the hub sidebar — the FALLBACK
 * for series whose list has no entry of its own in the sidebar IA. When the
 * list *is* in the sidebar (e.g. a tentpole), it expands in place instead (see
 * `SidebarNavLink`) and `HubLayout` skips this pinned block. See
 * lat.md/decisions.md "Series posts keep the hub sidebar" (hybrid).
 *
 * Reads the `useList`/`useProgress` context (present only inside the
 * `(content)/[post]` layout), so it renders nothing on every other hub page.
 */
export function PinnedSeriesNav() {
	const { list } = useList()
	const { progress } = useProgress()

	if (!list) return null

	return (
		<>
			<SidebarGroup className="py-0">
				<SidebarGroupLabel className={CATEGORY_LABEL_CLASS}>
					In this series
				</SidebarGroupLabel>
			</SidebarGroup>
			<SidebarGroup className="py-0">
				<Link
					href={`/${list.fields.slug}`}
					className="focus-visible:ring-ring text-sidebar-foreground hover:bg-muted block px-2 py-1.5 text-sm font-semibold leading-snug tracking-tight text-balance transition-colors focus-visible:outline-none focus-visible:ring-2"
				>
					{list.fields.title}
				</Link>
				<SeriesLessons
					resources={list.resources as any}
					completedLessons={progress?.completedLessons}
				/>
			</SidebarGroup>
			<SidebarSeparator className="my-2" />
		</>
	)
}
