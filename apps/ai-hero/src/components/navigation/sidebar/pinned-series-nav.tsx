'use client'

import * as React from 'react'
import Link from 'next/link'
import { useList } from '@/app/(content)/[post]/_components/list-provider'
import { useProgress } from '@/app/(content)/[post]/_components/progress-provider'
import { listHomeHref } from '@/lib/list-home'

import {
	SidebarGroup,
	SidebarGroupLabel,
	SidebarSeparator,
} from '@coursebuilder/ui'

import { SeriesLessons } from './series-lessons'
import { SIDEBAR_LABEL_CLASS } from './sidebar-indent'

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
				<SidebarGroupLabel className={SIDEBAR_LABEL_CLASS}>
					In this series
				</SidebarGroupLabel>
			</SidebarGroup>
			<SidebarGroup className="py-0">
				{/* The series title is the one row here that is a TITLE, not an item,
				    so it keeps its weight — but it takes the rows' 10px indent and
				    6px radius so it sits on their left edge. */}
				<Link
					href={listHomeHref(list.fields.slug)}
					className="focus-visible:ring-ring text-sidebar-foreground hover:bg-muted block rounded-sm px-2.5 py-1.5 text-sm font-semibold leading-snug tracking-tight text-balance transition-colors focus-visible:outline-none focus-visible:ring-2"
				>
					{list.fields.title}
				</Link>
				<SeriesLessons
					resources={list.resources as any}
					completedLessons={progress?.completedLessons}
				/>
			</SidebarGroup>
			<SidebarSeparator className="mx-2.5 my-3" />
		</>
	)
}
