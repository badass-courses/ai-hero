'use client'

import * as React from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { track } from '@/utils/analytics'
import {
	BookA,
	Compass,
	Map as MapIcon,
	Newspaper,
	PanelLeftClose,
	PanelLeftOpen,
	Sparkles,
	Wrench,
	type LucideIcon,
} from 'lucide-react'

import { Sidebar, SidebarContent } from '@coursebuilder/ui'
import { cn } from '@coursebuilder/ui/utils/cn'

import { normalizePath } from './sidebar-client'

/**
 * Icon-rail shortcuts shown while the sidebar is collapsed. Static by design:
 * the rail is chrome, not curation — the MDX-driven content only shows in the
 * expanded state. Every href is a real, existing route.
 */
const ICON_RAIL_LINKS: { label: string; href: string; icon: LucideIcon }[] = [
	{ label: 'Map', href: '/learn', icon: MapIcon },
	{ label: 'Posts', href: '/posts', icon: Newspaper },
	{ label: 'AI Coding Dictionary', href: '/ai-coding-dictionary', icon: BookA },
	{ label: 'Principles', href: '/principles', icon: Compass },
	{ label: 'Skills', href: '/skills', icon: Sparkles },
	{ label: 'Tools', href: '/tools', icon: Wrench },
]

const STICKY_SIDEBAR_CLASSES =
	'bg-background top-(--nav-height) sticky hidden h-[calc(100svh-var(--nav-height))] self-start border-r md:flex'

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
}: {
	children: React.ReactNode
	defaultCollapsed?: boolean
}) {
	const [collapsed, setCollapsed] = React.useState(defaultCollapsed)
	const pathname = usePathname()
	const current = normalizePath(pathname ?? '/')

	const toggle = () => {
		setCollapsed((value) => {
			track('nav_sidebar_toggled', {
				collapsed: !value,
				category: 'hub_sidebar',
			})
			return !value
		})
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
				<div aria-hidden="true" className="bg-border my-1 h-px w-6 shrink-0" />
				<nav className="flex flex-col items-center gap-1">
					{ICON_RAIL_LINKS.map((item) => {
						const isActive = normalizePath(item.href) === current
						return (
							<Link
								key={item.href}
								href={item.href}
								prefetch={false}
								title={item.label}
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
								<item.icon className="size-4" />
								<span className="sr-only">{item.label}</span>
							</Link>
						)
					})}
				</nav>
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
			<SidebarContent className="gap-0 py-2">{children}</SidebarContent>
		</Sidebar>
	)
}
