'use client'

import * as React from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { track } from '@/utils/analytics'
import {
	BookA,
	BookOpenText,
	Layers3,
	Newspaper,
	PanelLeftClose,
	PanelLeftOpen,
	Route,
	type LucideIcon,
} from 'lucide-react'

import { Sidebar, SidebarContent } from '@coursebuilder/ui'
import { cn } from '@coursebuilder/ui/utils/cn'

import * as TooltipPrimitive from '@radix-ui/react-tooltip'

import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from '@/components/ui/tooltip'

import { NAV_ICONS, type NavIconProps } from './nav-icons'
import { normalizePath } from './sidebar-client'
import type { CollapsedSidebarSection } from './sidebar-rail'

/** Adapt a lucide glyph to the `NavIconProps` shape (drops `active`). */
function lucideIcon(Icon: LucideIcon) {
	return function LucideNavIcon({ className }: NavIconProps) {
		return <Icon className={className} />
	}
}

/** Visual vocabulary only. Grouping and order come from the sidebar MDX. */
const RAIL_ICONS: Record<string, React.ComponentType<NavIconProps>> = {
	'/learn': NAV_ICONS['/learn']!,
	'/principles': NAV_ICONS['/principles']!,
	'/skills': NAV_ICONS['/skills']!,
	'/open-source': NAV_ICONS['/open-source']!,
	'/llm-fundamentals': lucideIcon(BookOpenText),
	'/ai-engineer-roadmap': lucideIcon(Route),
	'/ai-coding-dictionary': lucideIcon(BookA),
	'/posts': lucideIcon(Newspaper),
}

// `bg-sidebar`, not `bg-background`: the rail sits on the raised surface so it
// separates from the content (the spec's `--ah-bg-raised`). Hardcoding the page
// background here defeated the `--sidebar` token.
//
// `lg:` (1024px), not `md:` (768px). Two reasons, and the second is a bug:
// 264px of sidebar plus the article's 44px gutters leaves a 460px column at
// 768, which is below the prose measure; and `MobileMenuPanel` hides itself at
// `lg:`, so between 768 and 1024 the page rendered BOTH the desktop sidebar and
// the hamburger that opens the same tree in a drawer.
const STICKY_SIDEBAR_CLASSES =
	'bg-sidebar top-(--nav-height) w-[264px] sticky hidden h-[calc(100svh-var(--nav-height))] self-start border-r lg:flex'

/**
 * Client shell around the hub sidebar content. Two modes:
 *
 * - Default (`defaultCollapsed={false}`): the familiar full-width docs
 *   sidebar, no collapse affordance — regular hub pages are unchanged.
 * - Icon rail (`defaultCollapsed={true}`): dense catalog pages (`/posts`, the
 *   dictionary index) start as a slim rail of icon shortcuts that expands in
 *   place to the full sidebar on toggle.
 *
 * NOTE (deliberate choice): this is a slim custom rail per DESIGN.md, not the
 * shadcn `collapsible="icon"` Sidebar variant — that variant's fixed
 * inset/gap positioning fights the app's `--nav-height` sticky layout, which
 * is why the existing hub sidebar already opted for `collapsible="none"` +
 * sticky. The server-rendered sidebar content stays mounted as `children`, so
 * expanding never refetches.
 */
export function HubSidebarShell({
	children,
	defaultCollapsed = false,
	collapsedSections = [],
}: {
	children: React.ReactNode
	defaultCollapsed?: boolean
	collapsedSections?: CollapsedSidebarSection[]
}) {
	const [collapsed, setCollapsed] = React.useState(defaultCollapsed)
	const pathname = usePathname()
	const current = normalizePath(pathname ?? '/')

	// The next value is computed here rather than inside the updater: a state
	// updater has to be pure, and React deliberately calls it twice in
	// development — which fired two `nav_sidebar_toggled` events for one click.
	const toggle = () => {
		const next = !collapsed
		track('nav_sidebar_toggled', { collapsed: next, category: 'hub_sidebar' })
		setCollapsed(next)
	}

	if (collapsed) {
		return (
			<aside
				aria-label="Learning navigation (collapsed)"
				className={cn(
					STICKY_SIDEBAR_CLASSES,
					'w-12 flex-col items-center gap-1 py-2',
				)}
			>
				<button
					type="button"
					onClick={toggle}
					aria-label="Expand sidebar"
					aria-expanded={false}
					className="text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:ring-ring flex size-8 items-center justify-center focus-visible:outline-none focus-visible:ring-2"
				>
					<PanelLeftOpen className="size-4" />
				</button>
				{/* Real tooltips rather than the native `title`. Collapsed to a 48px
				    rail these links are icons and nothing else, so the label is the
				    only thing identifying them — and `title` takes about a second to
				    appear, renders wherever the OS decides, and is invisible to
				    touch and to keyboard focus.

				    Portalled to `document.body`: the rail is `sticky` inside a
				    fixed-width column, so a tooltip rendered in place is clipped by
				    the rail's own 48px box the moment it opens. The portal is what
				    makes "visible" true rather than hoped for. */}
				<TooltipProvider delayDuration={150}>
					<nav
						aria-label="Learning navigation shortcuts"
						className="flex min-h-0 flex-col items-center overflow-y-auto"
					>
						{collapsedSections.map((section, sectionIndex) => (
							<React.Fragment key={`${section.title}-${sectionIndex}`}>
								{sectionIndex > 0 ? (
									<div
										aria-hidden="true"
										className="bg-border my-1 h-px w-6 shrink-0"
									/>
								) : null}
								<div
									role="group"
									aria-label={section.title}
									className="flex flex-col items-center gap-1"
								>
									{section.links.map((item) => {
										const isActive = normalizePath(item.href) === current
										const Icon = RAIL_ICONS[normalizePath(item.href)]
										if (!Icon) return null

										return (
											<Tooltip key={item.href}>
												<TooltipTrigger asChild>
													<Link
														href={item.href}
														aria-current={isActive ? 'page' : undefined}
														onClick={() =>
															track('nav_link_clicked', {
																label: item.label,
																href: item.href,
																category: 'hub_sidebar_rail',
															})
														}
														className={cn(
															'focus-visible:ring-ring flex size-8 items-center justify-center focus-visible:outline-none focus-visible:ring-2',
															isActive
																? 'bg-accent text-accent-foreground'
																: 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
														)}
													>
														<Icon active={isActive} className="size-4" />
														<span className="sr-only">{item.label}</span>
													</Link>
												</TooltipTrigger>
												<TooltipPrimitive.Portal>
													<TooltipContent side="right" sideOffset={8}>
														{section.title} · {item.label}
													</TooltipContent>
												</TooltipPrimitive.Portal>
											</Tooltip>
										)
									})}
									{section.expandOnly ? (
										<Tooltip>
											<TooltipTrigger asChild>
												<button
													type="button"
													onClick={toggle}
													aria-label={`Open ${section.title}`}
													className="text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:ring-ring flex size-8 items-center justify-center focus-visible:outline-none focus-visible:ring-2"
												>
													<Layers3 className="size-4" />
												</button>
											</TooltipTrigger>
											<TooltipPrimitive.Portal>
												<TooltipContent side="right" sideOffset={8}>
													{section.title} · Open group
												</TooltipContent>
											</TooltipPrimitive.Portal>
										</Tooltip>
									) : null}
								</div>
							</React.Fragment>
						))}
					</nav>
				</TooltipProvider>
			</aside>
		)
	}

	return (
		<Sidebar
			collapsible="none"
			aria-label="Learning navigation"
			className={STICKY_SIDEBAR_CLASSES}
		>
			{defaultCollapsed ? (
				<div className="flex justify-end border-b px-2 py-1">
					<button
						type="button"
						onClick={toggle}
						aria-label="Collapse sidebar"
						aria-expanded={true}
						className="text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:ring-ring flex size-8 items-center justify-center focus-visible:outline-none focus-visible:ring-2"
					>
						<PanelLeftClose className="size-4" />
					</button>
				</div>
			) : null}
			{/* Gutter and rhythm are the prototype's `.ah-sidebar__inner`:
			    `24px 18px 32px`, and `gap-0` because the vertical rhythm is owned
			    by the group labels (`SIDEBAR_LABEL_CLASS` pads 26px above / 9px
			    below), not by the flex gap — a gap here would push a label away
			    from the very rows it names. */}
			<SidebarContent className="no-scrollbar scroll-fade gap-0 px-[18px] pb-8 pt-6">
				{children}
			</SidebarContent>
		</Sidebar>
	)
}
