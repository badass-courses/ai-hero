'use client'

import * as React from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useList } from '@/app/(content)/[post]/_components/list-provider'
import { useProgress } from '@/app/(content)/[post]/_components/progress-provider'
import { listHomeHref } from '@/lib/list-home'
import { track } from '@/utils/analytics'
import { ArrowRight, ChevronRight } from 'lucide-react'

import {
	SidebarGroup,
	SidebarGroupContent,
	SidebarGroupLabel,
	SidebarMenuAction,
	SidebarMenuButton,
} from '@coursebuilder/ui'

import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from '../../ui/collapsible'
import { NAV_ICONS } from './nav-icons'
import { rowIndent, SidebarDepth, useSidebarDepth } from './sidebar-indent'
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
				className="text-muted-foreground h-auto py-2 pr-2 text-sm font-normal"
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
						<ChevronRight className="text-muted-foreground ml-auto size-3.5 shrink-0 rotate-90" />
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

/**
 * A nav link that is ALSO a disclosure: the row navigates (icon + label →
 * `href`), a right-side chevron action toggles an indented child list
 * (Overview row + numbered items via `SeriesLessons`). Unlike the
 * `SidebarNavLink` current-list expansion, this works on EVERY hub page — no
 * list context needed; the items are server-loaded and passed in. Auto-opens
 * when the current page is the home or one of the items (and never
 * auto-collapses under the user). Used for Explore → Skills
 * (see lat.md/decisions.md "Series posts keep the hub sidebar").
 */
export function ExpandableNavLink({
	href,
	label,
	items,
}: {
	href: string
	label: React.ReactNode
	items: { id: string; slug: string; title: string }[]
}) {
	const pathname = usePathname()
	const depth = useSidebarDepth()
	const { progress } = useProgress()
	const current = normalizePath(pathname ?? '/')
	const activeInside =
		normalizePath(href) === current ||
		items.some((item) => normalizePath(`/${item.slug}`) === current)
	const [open, setOpen] = React.useState(activeInside)
	// Reveal on navigation into the group; manual toggling stays respected.
	React.useEffect(() => {
		if (activeInside) setOpen(true)
	}, [activeInside])

	const Icon = NAV_ICONS[normalizePath(href)]
	// When open, the row reads as a group header — the active highlight belongs
	// to the Overview child (SeriesLessons), not the parent.
	const isActive = !open && normalizePath(href) === current
	const resources = React.useMemo(
		() =>
			items.map((item) => ({
				resource: {
					id: item.id,
					type: 'post',
					fields: { slug: item.slug, title: item.title },
				} as any,
			})),
		[items],
	)

	return (
		<Collapsible
			open={open}
			onOpenChange={setOpen}
			className="group/collapsible"
		>
			<SidebarMenuButton
				asChild
				isActive={isActive}
				className="text-muted-foreground h-auto py-2 pr-7 text-sm font-normal"
				style={rowIndent(depth)}
			>
				<Link
					href={href}
					prefetch={false}
					aria-current={isActive ? 'page' : undefined}
					onClick={() =>
						track('nav_link_clicked', {
							label: typeof label === 'string' ? label : href,
							href,
							category: 'hub_sidebar',
						})
					}
				>
					{Icon ? <Icon active={isActive} className="size-4 shrink-0" /> : null}
					<span>{label}</span>
				</Link>
			</SidebarMenuButton>
			<CollapsibleTrigger asChild>
				<SidebarMenuAction
					aria-label={`Toggle ${typeof label === 'string' ? label : 'section'} list`}
					className="text-muted-foreground hover:text-foreground top-1/2 -translate-y-1/2 cursor-pointer"
					// Keep the chevron clear of the row's navigation click target.
					showOnHover={false}
				>
					<ChevronRight className="size-3.5 shrink-0 transition-transform group-data-[state=open]/collapsible:rotate-90" />
				</SidebarMenuAction>
			</CollapsibleTrigger>
			<CollapsibleContent>
				<SidebarDepth>
					<SeriesLessons
						resources={resources}
						completedLessons={progress?.completedLessons}
						overviewHref={href}
					/>
				</SidebarDepth>
			</CollapsibleContent>
		</Collapsible>
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
	children,
}: {
	title: string
	defaultOpen?: boolean
	children: React.ReactNode
}) {
	const pathname = usePathname()
	const depth = useSidebarDepth()
	const { list } = useList()
	// List precedence: if the active post belongs to a list, its list group owns
	// the open/highlight — Topics that merely also contain it don't auto-open.
	// (A Topic the user opens by hand still stays open; this only governs auto.)
	const listActive = Boolean(list)
	const hrefs = React.useMemo(() => collectHrefs(children), [children])
	const activeInside = React.useMemo(
		() =>
			!listActive &&
			hrefs.some(
				(href) => normalizePath(href) === normalizePath(pathname ?? '/'),
			),
		[hrefs, pathname, listActive],
	)
	const [open, setOpen] = React.useState(defaultOpen || activeInside)
	// Expand when navigation lands on one of this section's links (never
	// auto-collapse it out from under the user).
	React.useEffect(() => {
		if (activeInside) setOpen(true)
	}, [activeInside])

	return (
		<Collapsible
			open={open}
			onOpenChange={setOpen}
			className="group/collapsible"
		>
			<SidebarGroup className="p-0">
				<CollapsibleTrigger asChild>
					<SidebarGroupLabel
						asChild
						// Item-like when collapsed, bold when open. Same row indent as
						// sibling items; the disclosure chevron sits on the RIGHT
						// (2026-07-14 — unified across all sidebar disclosure rows).
						className="text-sidebar-foreground h-auto gap-1.5 py-2 pr-2 text-sm font-normal data-[state=open]:font-semibold"
						style={rowIndent(depth)}
					>
						<button
							type="button"
							className="flex w-full cursor-pointer select-none items-center"
							aria-label={`Toggle ${title} section`}
						>
							<span>{title}</span>
							<ChevronRight className="text-muted-foreground ml-auto size-3.5 shrink-0 transition-transform group-data-[state=open]/collapsible:rotate-90" />
						</button>
					</SidebarGroupLabel>
				</CollapsibleTrigger>
				<CollapsibleContent>
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
