'use client'

import * as React from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useList } from '@/app/(content)/[post]/_components/list-provider'
import { useProgress } from '@/app/(content)/[post]/_components/progress-provider'
import { listHomeHref } from '@/lib/list-home'
import { SKILLS_LIST_ID } from '@/lib/skills-content'
import { api } from '@/trpc/react'
import { track } from '@/utils/analytics'
import { ArrowRight, ChevronRight } from 'lucide-react'

import type { ModuleProgress } from '@coursebuilder/core/schemas'
import {
	SidebarGroup,
	SidebarGroupContent,
	SidebarGroupLabel,
	SidebarMenuButton,
} from '@coursebuilder/ui'
import { cn } from '@coursebuilder/ui/utils/cn'

import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from '../../ui/collapsible'
import { NAV_ICONS } from './nav-icons'
import {
	rowIndent,
	SIDEBAR_ROW_CLASS,
	SidebarDepth,
	useSidebarDepth,
} from './sidebar-indent'
import { SeriesLessons } from './series-lessons'

/** Strip query/hash + trailing slash, lowercase; '' → '/'. */
export function normalizePath(path: string): string {
	const trimmed = path.split(/[?#]/)[0]?.replace(/\/+$/, '') || ''
	return trimmed === '' ? '/' : trimmed.toLowerCase()
}

/**
 * A single sidebar nav link: `SidebarMenuButton` + `next/link` with
 * pathname-derived active state and analytics. Button-only — callers (the MDX
 * `li` mapping or the server section components) provide the surrounding
 * `SidebarMenuItem`.
 */
export function SidebarNavLink({
	href,
	children,
	muted = false,
	ariaLabel,
	series,
	onClick,
}: {
	href: string
	children: React.ReactNode
	muted?: boolean
	/** Accessible name when `children` is terse (e.g. the "All" links). */
	ariaLabel?: string
	/**
	 * Rows to disclose beneath this link, when it is the home of a series the
	 * reader is currently in. Supplying this puts the link in the same
	 * "expanded group header" state `isCurrentList` produces below — the
	 * caller has simply worked out membership some other way (the Skills entry
	 * knows its own item slugs without a `ListProvider`).
	 */
	series?: React.ReactNode
	/** Runs alongside the analytics call, before navigation. */
	onClick?: () => void
}) {
	const pathname = usePathname()
	const depth = useSidebarDepth()
	const { list } = useList()
	const { progress } = useProgress()
	// List precedence: when the current post belongs to a list, ONLY the list's
	// own expansion (SeriesLessons) highlights it — a copy of the same post in a
	// Topic stays un-highlighted. See decisions.md "Series posts keep the hub
	// sidebar" (list > topic).
	const listActive = Boolean(list)
	const isActive =
		!listActive && normalizePath(href) === normalizePath(pathname ?? '/')
	const Icon = NAV_ICONS[normalizePath(href)]

	// Hybrid series nav: when this link IS the current list's home page (its
	// landing, or the override — e.g. /skills for the skills list), it expands
	// in place to show the list's lessons (instead of a pinned block at the
	// top). Only fires inside the [post] layout, where the list context is
	// present. See lat.md/decisions.md "Series posts keep the hub sidebar".
	const isCurrentList =
		series !== undefined ||
		(Boolean(list) &&
			normalizePath(href) === normalizePath(listHomeHref(list!.fields.slug)))

	return (
		<>
			<SidebarMenuButton
				asChild
				// When this link is the expanded current list, it reads as a group
				// header — the active highlight belongs to its "Overview" child, not
				// the parent. Otherwise, normal active state.
				isActive={isCurrentList ? false : isActive}
				// Links read as the secondary tier: muted, regular weight. Left
				// indent comes from nesting depth (rowIndent), not ad-hoc pl-*.
				//
				// The active row is one of the three states the spec inverts between
				// themes (DESIGN rule 8): a gold wash with gold type in dark, a SOLID
				// ink fill with paper type in light. It can't come from
				// `--sidebar-accent`, because the primitive uses that same token for
				// hover — an ink-filled hover would light up every row the pointer
				// crosses. So the active fill is stated here and beats the
				// primitive's `data-[active=true]:bg-sidebar-accent` by order.
				className={cn(
					SIDEBAR_ROW_CLASS,
					isActive &&
						!isCurrentList && [
							'font-medium',
							'data-[active=true]:bg-foreground data-[active=true]:text-background',
							'dark:data-[active=true]:bg-accent-fill/10 dark:data-[active=true]:text-primary',
						],
				)}
				style={rowIndent(depth)}
			>
				<Link
					href={href}
					prefetch={false}
					// Not when this row is an expanded series header: its "Overview"
					// child is the row that points at this page and carries the
					// highlight, so claiming it here put the accessible "you are
					// here" on a different row than the visible one.
					aria-current={isActive && !isCurrentList ? 'page' : undefined}
					aria-label={ariaLabel}
					onClick={() => {
						onClick?.()
						track('nav_link_clicked', {
							label:
								ariaLabel ?? (typeof children === 'string' ? children : href),
							href,
							category: 'hub_sidebar',
						})
					}}
				>
					{Icon ? <Icon active={isActive} className="size-4 shrink-0" /> : null}
					<span>{children}</span>
					{/* Expanded current-list link reads as a group header — disclosure
					    chevron on the RIGHT (pointing down = expanded). */}
					{isCurrentList ? (
						<ChevronRight className="ml-auto size-3.5 shrink-0 rotate-90 text-[color:var(--ah-fg-faint)]" />
					) : null}
					{muted && !isCurrentList ? (
						/* "All →" style link: an inline arrow, a small child action. */
						<ArrowRight className="size-3.5 shrink-0 opacity-70" />
					) : null}
				</Link>
			</SidebarMenuButton>
			{series !== undefined ? (
				<SidebarDepth>{series}</SidebarDepth>
			) : isCurrentList ? (
				<SidebarDepth>
					<SeriesLessons
						resources={list!.resources as any}
						completedLessons={progress?.completedLessons}
						overviewHref={listHomeHref(list!.fields.slug)}
					/>
				</SidebarDepth>
			) : null}
		</>
	)
}

/**
 * The Explore "Skills" row, built on the same shape as a Guides link.
 *
 * It used to be a `SidebarSection` accordion, which meant it had a CLOSED
 * state — and that closed state is the whole problem. `pathname` does not
 * change until the RSC navigation commits, so arriving at /skills from
 * anywhere the reader could not click this row (the nav bar, a link in a post,
 * the back button) showed the previous page's collapsed section for the length
 * of the navigation and then expanded it. No amount of animation gating fixes
 * that: the shape itself has to change.
 *
 * A Guides link has no closed state to be caught in. It is a plain row until
 * the reader is inside it, and then it IS the expanded group: header, an
 * "Overview" child holding the active highlight, and the lessons. Nothing to
 * open, so arriving never looks like an opening. This is the same
 * `SidebarNavLink` those links use, handed its rows explicitly — the Skills
 * catalog knows its own slugs, so it does not need the `ListProvider` that
 * `isCurrentList` reads and that hub pages do not have.
 *
 * The cost, accepted: the skill list is no longer browsable from other hub
 * pages. It was the accordion that offered that, and the accordion is what
 * made the entry feel broken every time it was used.
 */
export function SkillsNavEntry({
	href,
	label,
	groups,
}: {
	href: string
	label: React.ReactNode
	groups: {
		id: string
		title: string | null
		items: { id: string; slug: string; title: string }[]
	}[]
}) {
	const pathname = usePathname()
	// Client-side so the ✓ marks can be late without the tree waiting on them.
	// Long `staleTime` + no refetching: progress only changes when this reader
	// completes something, and React Query keeps the answer across navigations,
	// so the marks do not flicker either.
	const { data: progress } = api.progress.moduleProgress.useQuery(
		{ moduleIdOrSlug: SKILLS_LIST_ID },
		{
			staleTime: 1000 * 60 * 5,
			gcTime: 1000 * 60 * 30,
			refetchOnMount: false,
			refetchOnWindowFocus: false,
			refetchOnReconnect: false,
		},
	)
	const completedLessons = progress?.completedLessons
	const current = normalizePath(pathname ?? '/')
	const pathInside =
		normalizePath(href) === current ||
		groups.some((group) =>
			group.items.some((item) => normalizePath(`/${item.slug}`) === current),
		)

	// Expand on the CLICK rather than on the navigation.
	//
	// `pathname` does not change until the RSC navigation commits — measured at
	// 850ms to 2.9s for /skills on this machine. Deriving the expanded state
	// from it alone means the reader clicks "Skills", nothing happens for most
	// of a second, and then the whole tree and its highlight appear at once.
	// That is the "closed first, then it opens" they see, and no amount of
	// animation or shape work touches it: the state simply is not allowed to
	// change yet.
	//
	// The click is unambiguous, so it does not need the server's permission.
	// Cleared on any pathname change, which covers both landing here (where
	// `pathInside` takes over) and going somewhere else instead.
	const [pending, setPending] = React.useState(false)
	React.useEffect(() => {
		setPending(false)
	}, [pathname])

	if (!pathInside && !pending) {
		return (
			<SidebarNavLink href={href} onClick={() => setPending(true)}>
				{label}
			</SidebarNavLink>
		)
	}

	return (
		<SidebarNavLink
			href={href}
			onClick={() => setPending(true)}
			series={
				<ListSectionLessons
					groups={groups}
					overviewHref={href}
					completedLessons={completedLessons}
					// While pending, the URL still names the old page, so the Overview
					// row cannot work out that it is the one being navigated to.
					forceOverviewActive={pending && !pathInside}
				/>
			}
		>
			{label}
		</SidebarNavLink>
	)
}

/** Icon lookup for section header rows (`NAV_ICONS` keyed by href). */
function IconFor(iconHref?: string) {
	const Icon = iconHref ? NAV_ICONS[normalizePath(iconHref)] : undefined
	return Icon ? <Icon active={false} className="size-4 shrink-0" /> : null
}

/**
 * Client bridge for data-driven series content inside a `SidebarSection`:
 * rebuilds resource-shaped rows (section sub-headings + lessons) from
 * serializable groups and renders `SeriesLessons`. Used by the Skills entry
 * (`SkillsEntry` in sidebar-sections) so the Explore Skills accordion is the
 * SAME component as the topic groups. Progress arrives as a PROP
 * (server-fetched for the skills list) — NOT from `useProgress`, whose
 * provider exists only in the [post] layout, which is why ✓ marks used to
 * vanish on /skills and other hub pages.
 */
export function ListSectionLessons({
	groups,
	overviewHref,
	completedLessons,
	forceOverviewActive,
}: {
	groups: {
		id: string
		title: string | null
		items: { id: string; slug: string; title: string }[]
	}[]
	overviewHref?: string
	completedLessons?: ModuleProgress['completedLessons']
	forceOverviewActive?: boolean
}) {
	const resources = React.useMemo(
		() =>
			groups.flatMap((group) => {
				const rows = group.items.map((item) => ({
					resource: {
						id: item.id,
						type: 'post',
						fields: { slug: item.slug, title: item.title },
					} as any,
				}))
				if (group.title === null) return rows
				return [
					{
						resource: {
							id: group.id,
							type: 'section',
							fields: { title: group.title },
							resources: rows,
						} as any,
					},
				]
			}),
		[groups],
	)

	return (
		<SeriesLessons
			resources={resources}
			completedLessons={completedLessons}
			overviewHref={overviewHref}
			forceOverviewActive={forceOverviewActive}
		/>
	)
}

/** Collect every `href` prop in a children tree (used for active detection). */
function collectHrefs(node: React.ReactNode, into: string[] = []): string[] {
	React.Children.forEach(node, (child) => {
		if (!React.isValidElement(child)) return
		const props = child.props as { href?: unknown; children?: React.ReactNode }
		if (typeof props.href === 'string') into.push(props.href)
		if (props.children) collectHrefs(props.children, into)
	})
	return into
}

/**
 * Collapsible topic group (e.g. "Ship Solid Code"): a disclosure triangle + a
 * label that reads like an item when collapsed and goes bold when open, over an
 * indented list of child links. Lives under a small-caps category header
 * ("Topics"); the categories themselves are non-collapsible `## headings`.
 *
 * Collapsed by default, but auto-opens when one of its descendant links is the
 * active page (so the current post's topic is expanded on load). The user can
 * still toggle any section by hand.
 */
export function SidebarSection({
	title,
	defaultOpen = false,
	iconHref,
	ownListSlug,
	extraHrefs,
	children,
}: {
	title: React.ReactNode
	defaultOpen?: boolean
	/** Optional `NAV_ICONS` key (an href) — renders that icon before the title. */
	iconHref?: string
	/**
	 * When this section IS a list's sidebar home (e.g. Skills = the
	 * `skills-catalog` list), the list's slug — exempts it from the
	 * list-precedence auto-open suppression so it opens on its own posts.
	 */
	ownListSlug?: string
	/** Hrefs counted for auto-open beyond the children element tree (used when
	 *  children render from data, invisible to `collectHrefs`). */
	extraHrefs?: string[]
	children: React.ReactNode
}) {
	const pathname = usePathname()
	const depth = useSidebarDepth()
	const { list } = useList()
	// List precedence: if the active post belongs to a list, its list group owns
	// the open/highlight — Topics that merely also contain it don't auto-open.
	// (A Topic the user opens by hand still stays open; this only governs auto.)
	// A section that IS the current list's home is exempt.
	const ownListActive = Boolean(
		list && ownListSlug !== undefined && list.fields.slug === ownListSlug,
	)
	const listActive = Boolean(list) && !ownListActive
	const childHrefs = React.useMemo(() => collectHrefs(children), [children])
	const hrefs = React.useMemo(
		() => [...childHrefs, ...(extraHrefs ?? [])],
		[childHrefs, extraHrefs],
	)
	const activeInside = React.useMemo(
		() =>
			!listActive &&
			hrefs.some(
				(href) => normalizePath(href) === normalizePath(pathname ?? '/'),
			),
		[hrefs, pathname, listActive],
	)
	const [open, setOpen] = React.useState(defaultOpen || activeInside)

	// Whether a disclosure animation is allowed to play. It is not, on the
	// first paint.
	//
	// `animate-collapsible-down` is bound to `data-[state=open]`, and Radix
	// sets that attribute on mount as well as on toggle — so a section that
	// mounts ALREADY open slid its whole tree down from zero height on arrival.
	// Landing on /skills looked like the accordion opening itself, because the
	// only thing distinguishing "already open" from "just opened" is whether a
	// reader asked for it.
	//
	// Both writers below turn it on in the same commit that changes `open`, so
	// the class is present the moment `data-state` flips and the animation
	// still plays for every change the reader causes or navigates into.
	const [animate, setAnimate] = React.useState(false)
	const handleOpenChange = React.useCallback((next: boolean) => {
		setAnimate(true)
		setOpen(next)
	}, [])

	// Expand when navigation LANDS on one of this section's links — the
	// false→true edge, not the condition. Never auto-collapses it out from
	// under the user, and equally never re-opens it: keying this on `open`
	// instead would re-fire the moment they collapsed the section they are
	// currently in, so the one section they most likely want out of the way
	// would be the one they could not close.
	//
	// The edge is also what keeps the first paint silent. On mount the ref
	// already holds `activeInside`, so arriving at /skills is no transition,
	// no state change, and nothing to animate.
	const wasActiveInside = React.useRef(activeInside)
	React.useEffect(() => {
		const landed = activeInside && !wasActiveInside.current
		wasActiveInside.current = activeInside
		if (!landed) return
		setAnimate(true)
		setOpen(true)
	}, [activeInside])

	return (
		<Collapsible
			open={open}
			onOpenChange={handleOpenChange}
			className="group/collapsible"
		>
			<SidebarGroup className="p-0">
				<CollapsibleTrigger asChild>
					<SidebarGroupLabel
						asChild
						// Item-like when collapsed, bold when open. Same row indent as
						// sibling items; the disclosure chevron sits on the RIGHT
						// (2026-07-14 — unified across all sidebar disclosure rows).
						// No `transition-colors`: every other sidebar row takes its hover
						// fill from `SidebarMenuButton`, which snaps. With a transition
						// here the section headers faded while the links under them
						// changed instantly, so one row in the rail moved differently
						// from the rest.
						className={cn(
							SIDEBAR_ROW_CLASS,
							'hover:bg-sidebar-accent hover:text-sidebar-accent-foreground data-[state=open]:text-sidebar-foreground',
						)}
						style={rowIndent(depth)}
					>
						{/* `gap-[9px]` restated on the child: `SidebarGroupLabel asChild`
						    slots onto this button, and Radix lets the CHILD's className
						    win — a `gap-2` here would silently beat the row metric. */}
						<button
							type="button"
							className="flex w-full cursor-pointer select-none items-center gap-[9px]"
							aria-label={`Toggle ${typeof title === 'string' ? title : 'this'} section`}
						>
							{IconFor(iconHref)}
							<span>{title}</span>
							<ChevronRight className="ml-auto size-3.5 shrink-0 text-[color:var(--ah-fg-faint)] transition-transform group-data-[state=open]/collapsible:rotate-90" />
						</button>
					</SidebarGroupLabel>
				</CollapsibleTrigger>
				{/* mt-px matches the menus' gap-px, so an open section's first row
				    sits on the same 1px rhythm as every other row boundary. */}
				<CollapsibleContent
					className={cn(
						'mt-px overflow-hidden',
						animate &&
							'data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down',
					)}
				>
					<SidebarDepth>
						<SidebarGroupContent>{children}</SidebarGroupContent>
					</SidebarDepth>
				</CollapsibleContent>
			</SidebarGroup>
		</Collapsible>
	)
}

/**
 * Last line of defense for the MDX-driven sidebar: if the compiled MDX tree
 * throws during (client) render, swap in the static fallback sidebar instead
 * of killing navigation. The fallback is server-rendered and passed as a prop.
 */
export class SidebarErrorBoundary extends React.Component<
	{ fallback: React.ReactNode; children: React.ReactNode },
	{ hasError: boolean }
> {
	constructor(props: { fallback: React.ReactNode; children: React.ReactNode }) {
		super(props)
		this.state = { hasError: false }
	}

	static getDerivedStateFromError() {
		return { hasError: true }
	}

	render() {
		if (this.state.hasError) return this.props.fallback
		return this.props.children
	}
}
