'use client'

import * as React from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useList } from '@/app/(content)/[post]/_components/list-provider'
import { useProgress } from '@/app/(content)/[post]/_components/progress-provider'
import { listHomeHref } from '@/lib/list-home'
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
}: {
	href: string
	children: React.ReactNode
	muted?: boolean
	/** Accessible name when `children` is terse (e.g. the "All" links). */
	ariaLabel?: string
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
		Boolean(list) &&
		normalizePath(href) === normalizePath(listHomeHref(list!.fields.slug))

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
					aria-current={isActive ? 'page' : undefined}
					aria-label={ariaLabel}
					onClick={() =>
						track('nav_link_clicked', {
							label:
								ariaLabel ?? (typeof children === 'string' ? children : href),
							href,
							category: 'hub_sidebar',
						})
					}
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
			{isCurrentList ? (
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
}: {
	groups: {
		id: string
		title: string | null
		items: { id: string; slug: string; title: string }[]
	}[]
	overviewHref?: string
	completedLessons?: ModuleProgress['completedLessons']
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
	href,
	ownListSlug,
	extraHrefs,
	children,
}: {
	title: React.ReactNode
	defaultOpen?: boolean
	/** Optional `NAV_ICONS` key (an href) — renders that icon before the title. */
	iconHref?: string
	/**
	 * When the section itself names a page (Skills → `/skills`), that page.
	 * The label becomes a link to it and the chevron alone toggles, so the
	 * header behaves like every other nav row instead of being the one piece
	 * of labelled navigation you cannot click through to.
	 */
	href?: string
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
				{href ? (
					// Split row: the label navigates, the chevron discloses. One
					// element cannot do both — a click that both routed away and
					// toggled would leave the section in a state the reader did not
					// ask for, and hiding the destination behind a nested "Overview"
					// row made the header the only label in the rail that looked like
					// a link and was not.
					<SidebarGroupLabel
						asChild
						className={cn(
							SIDEBAR_ROW_CLASS,
							'hover:bg-sidebar-accent hover:text-sidebar-accent-foreground data-[state=open]:text-sidebar-foreground pr-0',
						)}
						style={rowIndent(depth)}
					>
						<div className="flex w-full select-none items-center gap-[9px]">
							<Link
								href={href}
								aria-current={
									normalizePath(href) === normalizePath(pathname ?? '/')
										? 'page'
										: undefined
								}
								// Open on the CLICK, not on the navigation. Auto-open keys
								// off `activeInside`, which keys off `pathname`, which does
								// not change until the RSC navigation commits — measured at
								// ~800ms here. For that whole time the reader is still
								// looking at the previous page's sidebar with this section
								// shut, so clicking "Skills" looked like nothing happened
								// and then the tree appeared. Its own label is the one
								// click where the intent is unambiguous, so it does not
								// need to wait for the server to agree.
								onClick={() => handleOpenChange(true)}
								className="focus-visible:ring-ring flex min-w-0 flex-1 items-center gap-[9px] rounded-[6px] focus-visible:outline-none focus-visible:ring-2"
							>
								{IconFor(iconHref)}
								<span className="truncate">{title}</span>
							</Link>
							<CollapsibleTrigger asChild>
								{/* Its own 32px hit area, and its own label: "Skills" is
								    already spoken by the link beside it, so the button
								    needs to announce the disclosure, not the section.
								    `-my-[7px]` — exactly the row.s own `py-[7px]` — is what keeps that hit area from setting the
								    row's height — the row is `h-auto py-[7px]`, so a 32px
								    child made this one header taller than every sibling
								    row in the rail. The negative margin lets the button
								    overhang the padding instead of growing it. */}
								<button
									type="button"
									aria-label={`${open ? 'Collapse' : 'Expand'} ${typeof title === 'string' ? title : 'this'} section`}
									className="focus-visible:ring-ring -my-[7px] -mr-1 flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-[6px] focus-visible:outline-none focus-visible:ring-2"
								>
									<ChevronRight className="size-3.5 shrink-0 text-[color:var(--ah-fg-faint)] transition-transform group-data-[state=open]/collapsible:rotate-90" />
								</button>
							</CollapsibleTrigger>
						</div>
					</SidebarGroupLabel>
				) : (
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
				)}
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
