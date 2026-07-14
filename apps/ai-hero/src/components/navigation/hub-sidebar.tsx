'use client'

import * as React from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'

import {
	SidebarGroup,
	SidebarGroupContent,
	SidebarGroupLabel,
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
} from '@coursebuilder/ui'

function normalize(path: string): string {
	const trimmed = path.split(/[?#]/)[0]?.replace(/\/+$/, '') || ''
	return trimmed === '' ? '/' : trimmed.toLowerCase()
}

/**
 * Last-resort static sidebar. The primary sidebar and its degraded-mode
 * fallback are both MDX-driven (CMS `hub-sidebar` page or the bundled
 * `HUB_SIDEBAR_FALLBACK_MDX` default, compiled in `hub-layout.tsx`). This
 * renders only if even the bundled MDX fails to compile OR a render-time
 * crash trips `SidebarErrorBoundary` — so it is deliberately tiny, static, and
 * dependency-free: a handful of always-valid links that can never themselves
 * fail. Real IA lives in the MDX, never here.
 */
const MINIMAL_LINKS = [
	{ label: 'Map', href: '/learn' },
	{ label: 'Tools', href: '/tools' },
	{ label: 'All posts', href: '/posts' },
]

export function SidebarMinimalFallback() {
	const pathname = usePathname()
	const current = normalize(pathname ?? '/')

	return (
		<SidebarGroup>
			<SidebarGroupLabel>Explore</SidebarGroupLabel>
			<SidebarGroupContent>
				<SidebarMenu>
					{MINIMAL_LINKS.map((item) => (
						<SidebarMenuItem key={item.href}>
							<SidebarMenuButton
								asChild
								isActive={normalize(item.href) === current}
							>
								<Link
									href={item.href}
									prefetch={false}
									aria-current={
										normalize(item.href) === current ? 'page' : undefined
									}
								>
									<span>{item.label}</span>
								</Link>
							</SidebarMenuButton>
						</SidebarMenuItem>
					))}
				</SidebarMenu>
			</SidebarGroupContent>
		</SidebarGroup>
	)
}
