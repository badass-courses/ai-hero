'use client'

import * as React from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { track } from '@/utils/analytics'
import { Check } from 'lucide-react'

import type {
	ContentResource,
	ModuleProgress,
} from '@coursebuilder/core/schemas'
import {
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
} from '@coursebuilder/ui'
import { cn } from '@coursebuilder/ui/utils/cn'

/** Local path normalizer — kept here to avoid a cycle with sidebar-client. */
function norm(path: string): string {
	const trimmed = path.split(/[?#]/)[0]?.replace(/\/+$/, '') || ''
	return trimmed === '' ? '/' : trimmed.toLowerCase()
}

/** Flatten a list's resources to a lesson array (sections → their children). */
export function flattenLessons(
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
 * The lesson rows for a series: numbered, ✓ for completed, current highlighted.
 * Shared by the pinned "In this series" block and the inline expansion under a
 * list's own sidebar entry. Renders nothing when the list has no lessons.
 */
export function SeriesLessons({
	resources,
	completedLessons,
	overviewHref,
	className,
}: {
	resources: { resource?: ContentResource }[] | undefined
	completedLessons?: ModuleProgress['completedLessons']
	/** When set, an "Overview" row (the list landing page) leads the lessons. */
	overviewHref?: string
	className?: string
}) {
	const params = useParams()
	const currentSlug =
		typeof params.post === 'string' ? norm(`/${params.post}`) : undefined
	const lessons = flattenLessons(resources)
	if (lessons.length === 0) return null

	const completed = new Set(
		(completedLessons ?? []).filter((l) => l.completedAt).map((l) => l.resourceId),
	)
	const overviewActive =
		overviewHref !== undefined && norm(overviewHref) === currentSlug

	return (
		<SidebarMenu className={className}>
			{overviewHref !== undefined ? (
				<SidebarMenuItem>
					<SidebarMenuButton
						asChild
						isActive={overviewActive}
						className="text-muted-foreground h-auto items-start gap-2 py-2 pl-2 pr-2 text-sm font-normal"
					>
						<Link href={overviewHref} prefetch={false}>
							<span
								aria-hidden
								className="text-muted-foreground/60 flex w-4 shrink-0 justify-center pt-px font-mono text-[11px]"
							>
								·
							</span>
							<span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
								Overview
							</span>
						</Link>
					</SidebarMenuButton>
				</SidebarMenuItem>
			) : null}
			{lessons.map((lesson, index) => {
				const slug = lesson.fields?.slug as string | undefined
				if (!slug) return null
				const isActive = norm(`/${slug}`) === currentSlug
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
	)
}
