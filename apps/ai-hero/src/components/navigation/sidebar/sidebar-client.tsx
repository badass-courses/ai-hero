'use client'

import * as React from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { track } from '@/utils/analytics'
import { ChevronRight } from 'lucide-react'

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
}: {
	href: string
	children: React.ReactNode
	muted?: boolean
}) {
	const pathname = usePathname()
	const isActive = normalizePath(href) === normalizePath(pathname ?? '/')

	return (
		<SidebarMenuButton asChild isActive={isActive}>
			<Link
				href={href}
				prefetch={false}
				aria-current={isActive ? 'page' : undefined}
				className={muted ? 'text-muted-foreground' : undefined}
				onClick={() =>
					track('nav_link_clicked', {
						label: typeof children === 'string' ? children : href,
						href,
						category: 'hub_sidebar',
					})
				}
			>
				<span>{children}</span>
				{muted ? <ChevronRight className="ml-auto size-4" /> : null}
			</Link>
		</SidebarMenuButton>
	)
}

/**
 * Collapsible sidebar section: label row toggles the content below. Used both
 * as an MDX author-facing component (`<SidebarSection title="…">`) and as the
 * chrome for the server-driven sections (What's New, Skills, topics).
 */
export function SidebarSection({
	title,
	defaultOpen = true,
	children,
}: {
	title: string
	defaultOpen?: boolean
	children: React.ReactNode
}) {
	return (
		<Collapsible defaultOpen={defaultOpen} className="group/collapsible">
			<SidebarGroup className="py-1">
				<CollapsibleTrigger asChild>
					<SidebarGroupLabel asChild>
						<button
							type="button"
							className="w-full cursor-pointer select-none"
							aria-label={`Toggle ${title} section`}
						>
							<span>{title}</span>
							<ChevronRight className="ml-auto size-4 transition-transform group-data-[state=open]/collapsible:rotate-90" />
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
