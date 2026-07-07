'use client'

import * as React from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { track } from '@/utils/analytics'
import { ArrowRight, ChevronRight } from 'lucide-react'

import {
	SidebarGroup,
	SidebarGroupContent,
	SidebarGroupLabel,
	SidebarMenuButton,
} from '@coursebuilder/ui'

import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from '../../ui/collapsible'

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
	const isActive = normalizePath(href) === normalizePath(pathname ?? '/')

	return (
		<SidebarMenuButton
			asChild
			isActive={isActive}
			// Links read as the secondary tier: muted, regular weight, indented
			// under the bold group label, with comfortable vertical rhythm. Hover
			// + active states (accent bg + foreground) come from the primitive.
			className="text-muted-foreground h-auto py-2 pl-5 pr-2 text-sm font-normal"
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
				<span>{children}</span>
				{/* "All →" style link: an inline arrow, not a full-width row, so it
				    reads as a small child action indented under the group. */}
				{muted ? <ArrowRight className="size-3.5 shrink-0 opacity-70" /> : null}
			</Link>
		</SidebarMenuButton>
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
	const hrefs = React.useMemo(() => collectHrefs(children), [children])
	const activeInside = React.useMemo(
		() =>
			hrefs.some(
				(href) => normalizePath(href) === normalizePath(pathname ?? '/'),
			),
		[hrefs, pathname],
	)
	const [open, setOpen] = React.useState(defaultOpen || activeInside)
	// Expand when navigation lands on one of this section's links.
	React.useEffect(() => {
		if (activeInside) setOpen(true)
	}, [activeInside])

	return (
		<Collapsible
			open={open}
			onOpenChange={setOpen}
			className="group/collapsible"
		>
			<SidebarGroup className="py-0">
				<CollapsibleTrigger asChild>
					<SidebarGroupLabel
						asChild
						// Item-like when collapsed, bold when open; the triangle sits in
						// the left indent gutter so the label aligns with sibling items.
						className="text-sidebar-foreground h-auto gap-1.5 px-2 py-2 text-sm font-normal data-[state=open]:font-semibold"
					>
						<button
							type="button"
							className="w-full cursor-pointer select-none"
							aria-label={`Toggle ${title} section`}
						>
							<ChevronRight className="text-muted-foreground size-3.5 shrink-0 transition-transform group-data-[state=open]/collapsible:rotate-90" />
							<span>{title}</span>
						</button>
					</SidebarGroupLabel>
				</CollapsibleTrigger>
				<CollapsibleContent>
					<SidebarGroupContent>{children}</SidebarGroupContent>
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
