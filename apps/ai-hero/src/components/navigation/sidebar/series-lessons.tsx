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

import { rowIndent, useSidebarDepth } from './sidebar-indent'

/** Local path normalizer — kept here to avoid a cycle with sidebar-client. */
function norm(path: string): string {
	const trimmed = path.split(/[?#]/)[0]?.replace(/\/+$/, '') || ''
	return trimmed === '' ? '/' : trimmed.toLowerCase()
}

type SeriesRow =
	| { kind: 'section'; id: string; title: string }
	| { kind: 'lesson'; lesson: ContentResource; n: number }

/**
 * Walk a list's resources into render rows: a `section` contributes a
 * sub-heading row followed by its children; loose lessons pass through.
 * Lesson numbering is continuous across the whole series.
 */
export function toSeriesRows(
	resources: { resource?: ContentResource }[] | undefined,
): SeriesRow[] {
	const rows: SeriesRow[] = []
	let n = 0
	for (const entry of resources ?? []) {
		const res = entry?.resource
		if (!res) continue
		if (res.type === 'section') {
			const children = ((res as any).resources ?? []).filter(
				(child: any) => child?.resource,
			)
			if (children.length === 0) continue
			const title = (res as any).fields?.title
			if (typeof title === 'string' && title) {
				rows.push({ kind: 'section', id: res.id, title })
			}
			for (const child of children) {
				rows.push({ kind: 'lesson', lesson: child.resource, n: ++n })
			}
		} else {
			rows.push({ kind: 'lesson', lesson: res, n: ++n })
		}
	}
	return rows
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
	const depth = useSidebarDepth()
	const currentSlug =
		typeof params.post === 'string' ? norm(`/${params.post}`) : undefined
	const rows = toSeriesRows(resources)
	if (!rows.some((row) => row.kind === 'lesson')) return null

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
						className="text-muted-foreground h-auto items-start gap-2 py-2 pr-2 text-sm font-normal"
						style={rowIndent(depth)}
					>
						<Link href={overviewHref} prefetch={false}>
							<span
								aria-hidden
								className="text-muted-foreground/60 flex h-5 w-4 shrink-0 items-center justify-center font-mono text-[11px] tabular-nums"
							>
								0
							</span>
							<span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
								Overview
							</span>
						</Link>
					</SidebarMenuButton>
				</SidebarMenuItem>
			) : null}
			{rows.map((row) => {
				if (row.kind === 'section') {
					// Section sub-heading: small-caps label row, same indent as the
					// lessons it introduces (mirrors the desktop list rendering).
					return (
						<SidebarMenuItem key={row.id}>
							<div
								className="text-muted-foreground select-none pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wider"
								style={rowIndent(depth)}
							>
								{row.title}
							</div>
						</SidebarMenuItem>
					)
				}
				const { lesson, n } = row
				const slug = lesson.fields?.slug as string | undefined
				if (!slug) return null
				const isActive = norm(`/${slug}`) === currentSlug
				const isDone = completed.has(lesson.id)
				return (
					<SidebarMenuItem key={lesson.id}>
						<SidebarMenuButton
							asChild
							isActive={isActive}
							className="text-muted-foreground h-auto items-start gap-2 py-2 pr-2 text-sm font-normal"
						style={rowIndent(depth)}
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
										'flex h-5 w-4 shrink-0 items-center justify-center font-mono text-[11px] tabular-nums',
										isDone
											? 'text-foreground dark:text-primary'
											: 'text-muted-foreground/60',
									)}
								>
									{isDone ? (
										<Check className="size-3.5" strokeWidth={2.4} />
									) : (
										n
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
