'use client'

import * as React from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
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
import {
	rowIndent,
	SIDEBAR_NESTED_ROW_CLASS,
	SIDEBAR_NUM_CLASS,
	SidebarDepth,
	useSidebarDepth,
} from './sidebar-indent'

/** Local path normalizer — kept here to avoid a cycle with sidebar-client. */
function norm(path: string): string {
	const trimmed = path.split(/[?#]/)[0]?.replace(/\/+$/, '') || ''
	return trimmed === '' ? '/' : trimmed.toLowerCase()
}

/** `n` is a display label, not an index: "4" for a top-level lesson, "3.2" for
 *  the second lesson of the third top-level entry. */
type NumberedLesson = { lesson: ContentResource; n: string }
type SeriesGroup =
	| { kind: 'loose'; id: string; lessons: NumberedLesson[] }
	| {
			kind: 'section'
			id: string
			title: string
			/** The section's own position in the series, e.g. 3 for "3.1, 3.2, …". */
			n: number
			lessons: NumberedLesson[]
	  }

/**
 * Walk a list's resources into render groups: a `section` becomes a titled,
 * collapsible group of its children; consecutive loose lessons collapse into
 * untitled runs.
 *
 * Numbering is outline-style. One counter runs over TOP-LEVEL entries, so a
 * section and a loose lesson are peers in it; a section's children then number
 * within their parent ("3.1", "3.2"). Sections are entries in their own right,
 * which is why they consume a number rather than being transparent.
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
			const children = (((res as any).resources ?? []) as any[]).filter(
				(child) => child?.resource,
			)
			if (children.length === 0) continue
			looseRun = null
			const sectionNumber = ++n
			const title = (res as any).fields?.title
			groups.push({
				kind: 'section',
				id: res.id,
				title: typeof title === 'string' && title ? title : 'Section',
				n: sectionNumber,
				lessons: children.map((child, i) => ({
					lesson: child.resource,
					n: `${sectionNumber}.${i + 1}`,
				})),
			})
		} else {
			if (!looseRun) {
				looseRun = { kind: 'loose', id: `loose-${groups.length}`, lessons: [] }
				groups.push(looseRun)
			}
			looseRun.lessons.push({ lesson: res, n: String(++n) })
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
	forceOverviewActive = false,
	className,
}: {
	resources: { resource?: ContentResource }[] | undefined
	completedLessons?: ModuleProgress['completedLessons']
	/** When set, an "Overview" row (the list landing page) leads the lessons. */
	overviewHref?: string
	/**
	 * Treat the Overview row as current even though `pathname` does not say so
	 * yet. For the moment between clicking a list's own row and the navigation
	 * committing — the highlight belongs to the row the reader just chose, not
	 * to whatever the URL still says.
	 */
	forceOverviewActive?: boolean
	className?: string
}) {
	const pathname = usePathname()
	const depth = useSidebarDepth()
	// Pathname, not useParams().post — that param only exists on [post] routes,
	// which left the Overview row inactive on non-post homes like /skills.
	const currentSlug = pathname ? norm(pathname) : undefined
	const groups = toSeriesGroups(resources)
	if (groups.length === 0) return null

	const completed = new Set(
		(completedLessons ?? [])
			.filter((l) => l.completedAt)
			.map((l) => l.resourceId)
			.filter((id): id is string => typeof id === 'string'),
	)
	const overviewActive =
		overviewHref !== undefined &&
		(forceOverviewActive || norm(overviewHref) === currentSlug)

	return (
		<SidebarMenu className={cn('gap-px', className)}>
			{overviewHref !== undefined ? (
				<SidebarMenuItem>
					<SidebarMenuButton
						asChild
						isActive={overviewActive}
						className={SIDEBAR_NESTED_ROW_CLASS}
						style={rowIndent(depth)}
					>
						<Link
							href={overviewHref}
							prefetch={false}
							// This row, not the group header above it, is the one that
							// points at the list's own page and shows the active fill.
							aria-current={overviewActive ? 'page' : undefined}
						>
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
						n={group.n}
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
	n,
	lessons,
	currentSlug,
	completed,
}: {
	title: string
	n: number
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
						className={cn(
							SIDEBAR_NESTED_ROW_CLASS,
							'hover:bg-sidebar-accent hover:text-sidebar-accent-foreground group-data-[state=open]/series-section:text-foreground flex w-full cursor-pointer select-none transition-colors',
						)}
						style={rowIndent(depth)}
					>
						{/* w-4 sits between the lesson rows' w-5 and content width: a
						    section number is a single figure, so it needs less room than
						    "3.2", but flush against the title reads cramped. */}
						<span
							aria-hidden
							className={cn(
								SIDEBAR_NUM_CLASS,
								'w-4 text-[color:var(--ah-fg-faint)]',
							)}
						>
							{n}
						</span>
						<span className="min-w-0 truncate">{title}</span>
						{/* self-center is gone with items-start: the chevron holds the
						    first line, like the numeral opposite it. */}
						<ChevronRight className="ml-auto mt-0.5 size-3.5 shrink-0 text-[color:var(--ah-fg-faint)] transition-transform group-data-[state=open]/series-section:rotate-90" />
					</button>
				</CollapsibleTrigger>
				<CollapsibleContent className="mt-px overflow-hidden data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down">
					{/* One level deeper than the section header, so "3.1" sits under
					    "3" rather than beside it. */}
					<SidebarDepth>
						<SidebarMenu className="gap-px">
							{lessons.map((numbered) => (
								<LessonRow
									key={numbered.lesson.id}
									numbered={numbered}
									currentSlug={currentSlug}
									completed={completed}
								/>
							))}
						</SidebarMenu>
					</SidebarDepth>
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
				className={SIDEBAR_NESTED_ROW_CLASS}
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
							SIDEBAR_NUM_CLASS,
							// w-5, not w-4: section children render "3.2", not "7". Five is
							// what "3.2" measures at 9.5px mono; six was slack the title
							// could have been using.
							'w-5',
							isDone
								? 'text-foreground dark:text-primary'
								: 'text-[color:var(--ah-fg-faint)]',
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
