'use client'

import * as React from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { useList } from '@/app/(content)/[post]/_components/list-provider'
import { useProgress } from '@/app/(content)/[post]/_components/progress-provider'
import { track } from '@/utils/analytics'
import { Check } from 'lucide-react'

import type { ContentResource } from '@coursebuilder/core/schemas'
import {
	SidebarGroup,
	SidebarGroupLabel,
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
	SidebarSeparator,
} from '@coursebuilder/ui'
import { cn } from '@coursebuilder/ui/utils/cn'

import { normalizePath } from './sidebar-client'

const CATEGORY_LABEL_CLASS =
	'text-muted-foreground h-auto px-2 pb-1 pt-5 text-[11px] font-semibold uppercase tracking-wider'

/** Flatten a list's resources to a lesson array (sections → their children). */
function flattenLessons(
	resources: { resource?: ContentResource }[] | undefined,
): ContentResource[] {
	const out: ContentResource[] = []
	for (const entry of resources ?? []) {
		const res = entry?.resource
		if (!res) continue
		if (res.type === 'section') {
			for (const child of (res as any).resources ?? []) {
				if (child?.resource) out.push(child.resource)
			}
		} else {
			out.push(res)
		}
	}
	return out
}

/**
 * "In this series" group pinned to the TOP of the hub sidebar when the current
 * post belongs to a list (tutorial/series). Renders the list title + its
 * lessons with progress (✓ done, current highlighted), then a separator before
 * the hub categories below.
 *
 * Reads the server-seeded `useList`/`useProgress` context (present only inside
 * the `(content)/[post]` layout), so it renders nothing on every other hub
 * page — safe to mount unconditionally inside `HubLayout`. This is the
 * "keep the breadth, don't lose the depth" call from
 * lat.md/decisions.md "Series posts keep the hub sidebar".
 */
export function PinnedSeriesNav() {
	const { list } = useList()
	const { progress } = useProgress()
	const params = useParams()

	if (!list) return null

	const lessons = flattenLessons(list.resources as any)
	if (lessons.length === 0) return null

	const currentSlug =
		typeof params.post === 'string' ? normalizePath(`/${params.post}`) : undefined
	const completed = new Set(
		(progress?.completedLessons ?? [])
			.filter((l) => l.completedAt)
			.map((l) => l.resourceId),
	)

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
				<SidebarMenu>
					{lessons.map((lesson, index) => {
						const slug = lesson.fields?.slug as string | undefined
						if (!slug) return null
						const isActive = normalizePath(`/${slug}`) === currentSlug
						const isDone = completed.has(lesson.id)
						return (
							<SidebarMenuItem key={lesson.id}>
								<SidebarMenuButton
									asChild
									isActive={isActive}
									className="text-muted-foreground h-auto items-start gap-2 py-2 pl-2 pr-2 text-sm font-normal"
								>
									<Link
										href={`/${slug}`}
										prefetch={false}
										aria-current={isActive ? 'page' : undefined}
										onClick={() =>
											track('nav_link_clicked', {
												label: lesson.fields?.title,
												href: `/${slug}`,
												category: 'hub_sidebar_series',
											})
										}
									>
										<span
											aria-hidden
											className={cn(
												'flex w-4 shrink-0 justify-center pt-px font-mono text-[11px] tabular-nums',
												isDone
													? 'text-foreground dark:text-primary'
													: 'text-muted-foreground/60',
											)}
										>
											{isDone ? (
												<Check className="size-3.5" strokeWidth={2.4} />
											) : (
												String(index + 1).padStart(2, '0')
											)}
										</span>
										<span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
											{lesson.fields?.title}
										</span>
									</Link>
								</SidebarMenuButton>
							</SidebarMenuItem>
						)
					})}
				</SidebarMenu>
			</SidebarGroup>
			<SidebarSeparator className="my-2" />
		</>
	)
}
