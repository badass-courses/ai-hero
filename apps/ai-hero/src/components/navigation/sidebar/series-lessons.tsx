'use client'

import * as React from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { track } from '@/utils/analytics'
import { Check, ChevronRight } from 'lucide-react'

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

import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from '../../ui/collapsible'
import { rowIndent, useSidebarDepth } from './sidebar-indent'

/** Local path normalizer — kept here to avoid a cycle with sidebar-client. */
function norm(path: string): string {
	const trimmed = path.split(/[?#]/)[0]?.replace(/\/+$/, '') || ''
	return trimmed === '' ? '/' : trimmed.toLowerCase()
}

type NumberedLesson = { lesson: ContentResource; n: number }
type SeriesGroup =
	| { kind: 'loose'; id: string; lessons: NumberedLesson[] }
	| { kind: 'section'; id: string; title: string; lessons: NumberedLesson[] }

/**
 * Walk a list's resources into render groups: a `section` becomes a titled,
 * collapsible group of its children; consecutive loose lessons collapse into
 * untitled runs. Lesson numbering is continuous across the whole series.
 */
export function toSeriesGroups(
	resources: { resource?: ContentResource }[] | undefined,
): SeriesGroup[] {
	const groups: SeriesGroup[] = []
	let looseRun: Extract<SeriesGroup, { kind: 'loose' }> | null = null
	let n = 0
	for (const entry of resources ?? []) {
		const res = entry?.resource
		if (!res) continue
		if (res.type === 'section') {
			const lessons = (((res as any).resources ?? []) as any[])
				.filter((child) => child?.resource)
				.map((child) => ({ lesson: child.resource, n: ++n }))
			if (lessons.length === 0) continue
			looseRun = null
			const title = (res as any).fields?.title
			groups.push({
				kind: 'section',
				id: res.id,
				title: typeof title === 'string' && title ? title : 'Section',
				lessons,
			})
		} else {
			if (!looseRun) {
				looseRun = { kind: 'loose', id: `loose-${groups.length}`, lessons: [] }
				groups.push(looseRun)
			}
			looseRun.lessons.push({ lesson: res, n: ++n })
		}
	}
	return groups
}

/**
 * The lesson rows for a series: numbered, ✓ for completed, current highlighted;
 * list sections render as nested collapsible groups (closed by default,
 * auto-open when they contain the current post). Shared by the pinned "In this
 * series" block and the inline expansion under a list's own sidebar entry.
 * Renders nothing when the list has no lessons.
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
	const groups = toSeriesGroups(resources)
	if (groups.length === 0) return null

	const completed = new Set(
		(completedLessons ?? [])
			.filter((l) => l.completedAt)
			.map((l) => l.resourceId)
			.filter((id): id is string => typeof id === 'string'),
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
			{groups.map((group) =>
				group.kind === 'loose' ? (
					group.lessons.map((numbered) => (
						<LessonRow
							key={numbered.lesson.id}
							numbered={numbered}
							currentSlug={currentSlug}
							completed={completed}
						/>
					))
				) : (
					<SeriesSectionGroup
						key={group.id}
						title={group.title}
						lessons={group.lessons}
						currentSlug={currentSlug}
						completed={completed}
					/>
				),
			)}
		</SidebarMenu>
	)
}

/**
 * A list section inside a series expansion: the SAME collapsible pattern as
 * the sidebar accordions (right-side chevron), small-caps label, CLOSED by
 * default — auto-opens when it contains the current post (and never
 * auto-collapses under the user).
 */
function SeriesSectionGroup({
	title,
	lessons,
	currentSlug,
	completed,
}: {
	title: string
	lessons: NumberedLesson[]
	currentSlug: string | undefined
	completed: Set<string>
}) {
	const depth = useSidebarDepth()
	const activeInside = React.useMemo(
		() =>
			lessons.some(({ lesson }) => {
				const slug = lesson.fields?.slug
				return typeof slug === 'string' && norm(`/${slug}`) === currentSlug
			}),
		[lessons, currentSlug],
	)
	const [open, setOpen] = React.useState(activeInside)
	React.useEffect(() => {
		if (activeInside) setOpen(true)
	}, [activeInside])

	return (
		<SidebarMenuItem>
			<Collapsible
				open={open}
				onOpenChange={setOpen}
				className="group/series-section"
			>
				<CollapsibleTrigger asChild>
					<button
						type="button"
						aria-label={`Toggle ${title} section`}
						className="text-muted-foreground hover:text-foreground flex w-full cursor-pointer select-none items-center gap-2 pb-1 pt-3 pr-2 text-[11px] font-semibold uppercase tracking-wider transition-colors"
						style={rowIndent(depth)}
					>
						<span className="min-w-0 truncate">{title}</span>
						<ChevronRight className="ml-auto size-3.5 shrink-0 transition-transform group-data-[state=open]/series-section:rotate-90" />
					</button>
				</CollapsibleTrigger>
				<CollapsibleContent>
					<SidebarMenu>
						{lessons.map((numbered) => (
							<LessonRow
								key={numbered.lesson.id}
								numbered={numbered}
								currentSlug={currentSlug}
								completed={completed}
							/>
						))}
					</SidebarMenu>
				</CollapsibleContent>
			</Collapsible>
		</SidebarMenuItem>
	)
}

/** One numbered lesson row: ✓ when completed, highlighted when current. */
function LessonRow({
	numbered,
	currentSlug,
	completed,
}: {
	numbered: NumberedLesson
	currentSlug: string | undefined
	completed: Set<string>
}) {
	const depth = useSidebarDepth()
	const { lesson, n } = numbered
	const slug = lesson.fields?.slug as string | undefined
	if (!slug) return null
	const isActive = norm(`/${slug}`) === currentSlug
	const isDone = completed.has(lesson.id)

	return (
		<SidebarMenuItem>
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
						{isDone ? <Check className="size-3.5" strokeWidth={2.4} /> : n}
					</span>
					<span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
						{lesson.fields?.title}
					</span>
				</Link>
			</SidebarMenuButton>
		</SidebarMenuItem>
	)
}
