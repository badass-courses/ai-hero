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
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
	SidebarMenuSub,
	SidebarMenuSubButton,
	SidebarMenuSubItem,
} from '@coursebuilder/ui'

import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from '../ui/collapsible'
import {
	EXPLORE_LINKS,
	TENTPOLE_LINKS,
	TOPIC_GROUPS,
	WHATS_NEW_SEE_ALL_HREF,
	type SidebarLink,
} from './hub-sidebar-data'

function normalize(path: string): string {
	const trimmed = path.split(/[?#]/)[0]?.replace(/\/+$/, '') || ''
	return trimmed === '' ? '/' : trimmed.toLowerCase()
}

/**
 * STATIC FALLBACK sidebar content, driven by `hub-sidebar-data.ts`. The
 * primary sidebar is now MDX-driven (CMS `hub-sidebar` page compiled in
 * `hub-layout.tsx`); this renders when that page is missing or its MDX fails
 * to compile/render — a broken CMS edit must never kill nav.
 *
 * Content-only: the surrounding `Sidebar`/`SidebarContent` chrome lives in
 * `sidebar/sidebar-shell.tsx`. The dynamic "What's New" items are fetched
 * server-side and passed in to avoid layout shift.
 */
export function HubSidebarStaticContent({
	whatsNew,
}: {
	whatsNew: SidebarLink[]
}) {
	const pathname = usePathname()
	const current = normalize(pathname ?? '/')
	const isActive = (href: string) => normalize(href) === current

	const renderLink = (
		item: SidebarLink,
		Button: typeof SidebarMenuButton | typeof SidebarMenuSubButton,
	) => (
		<Button asChild isActive={isActive(item.href)}>
			<Link
				href={item.href}
				prefetch={false}
				aria-current={isActive(item.href) ? 'page' : undefined}
				onClick={() =>
					track('nav_link_clicked', {
						label: item.label,
						href: item.href,
						category: 'hub_sidebar',
					})
				}
			>
				<span>{item.label}</span>
			</Link>
		</Button>
	)

	return (
		<>
			<SidebarGroup>
				<SidebarGroupLabel>Explore</SidebarGroupLabel>
				<SidebarGroupContent>
					<SidebarMenu>
						{EXPLORE_LINKS.map((item) => (
							<SidebarMenuItem key={item.href}>
								{renderLink(item, SidebarMenuButton)}
							</SidebarMenuItem>
						))}
					</SidebarMenu>
				</SidebarGroupContent>
			</SidebarGroup>

			<SidebarGroup>
				<SidebarGroupLabel>Resources</SidebarGroupLabel>
				<SidebarGroupContent>
					<SidebarMenu>
						{TENTPOLE_LINKS.map((item) => (
							<SidebarMenuItem key={item.href}>
								{renderLink(item, SidebarMenuButton)}
							</SidebarMenuItem>
						))}
					</SidebarMenu>
				</SidebarGroupContent>
			</SidebarGroup>

			{whatsNew.length > 0 && (
				<SidebarGroup>
					<SidebarGroupLabel>What&apos;s New</SidebarGroupLabel>
					<SidebarGroupContent>
						<SidebarMenu>
							{whatsNew.map((item) => (
								<SidebarMenuItem key={item.href}>
									{renderLink(item, SidebarMenuButton)}
								</SidebarMenuItem>
							))}
							<SidebarMenuItem>
								<SidebarMenuButton asChild>
									<Link
										href={WHATS_NEW_SEE_ALL_HREF}
										prefetch={false}
										className="text-muted-foreground"
									>
										<span>See all</span>
										<ChevronRight className="ml-auto size-4" />
									</Link>
								</SidebarMenuButton>
							</SidebarMenuItem>
						</SidebarMenu>
					</SidebarGroupContent>
				</SidebarGroup>
			)}

			<SidebarGroup>
				<SidebarGroupLabel>Topics</SidebarGroupLabel>
				<SidebarGroupContent>
					<SidebarMenu>
						{TOPIC_GROUPS.map((group) => {
							const hasActiveChild = group.items.some((i) => isActive(i.href))
							return (
								<Collapsible
									key={group.label}
									defaultOpen={hasActiveChild}
									className="group/collapsible"
									asChild
								>
									<SidebarMenuItem>
										<CollapsibleTrigger asChild>
											<SidebarMenuButton>
												<span>{group.label}</span>
												<ChevronRight className="ml-auto size-4 transition-transform group-data-[state=open]/collapsible:rotate-90" />
											</SidebarMenuButton>
										</CollapsibleTrigger>
										<CollapsibleContent>
											<SidebarMenuSub>
												{group.items.map((item) => (
													<SidebarMenuSubItem key={item.href}>
														{renderLink(item, SidebarMenuSubButton)}
													</SidebarMenuSubItem>
												))}
											</SidebarMenuSub>
										</CollapsibleContent>
									</SidebarMenuItem>
								</Collapsible>
							)
						})}
					</SidebarMenu>
				</SidebarGroupContent>
			</SidebarGroup>
		</>
	)
}
