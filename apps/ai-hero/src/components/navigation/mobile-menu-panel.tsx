'use client'

import * as React from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { createAppAbility } from '@/ability'
import { api } from '@/trpc/react'
import { track } from '@/utils/analytics'
import { ArrowRightEndOnRectangleIcon } from '@heroicons/react/24/outline'
import { ChevronRight } from 'lucide-react'
import { signOut, useSession } from 'next-auth/react'

import {
	Accordion,
	AccordionContent,
	AccordionItem,
	AccordionTrigger,
	Button,
	SidebarMenuSkeleton,
} from '@coursebuilder/ui'
import { useFeedback } from '@coursebuilder/ui/feedback-widget/feedback-context'
import { cn } from '@coursebuilder/utils/cn'

import type { HubNavLink } from '@/lib/hub-sidebar-ia'

import {
	COURSES_NAV_ITEM,
	PRIMARY_LEARNING_ENTRY,
	PRIMARY_NAV_ITEMS,
} from './primary-nav'
import { ThemeToggle } from './theme-toggle'

function normalize(path: string): string {
	const trimmed = path.split(/[?#]/)[0]?.replace(/\/+$/, '') || ''
	return trimmed === '' ? '/' : trimmed.toLowerCase()
}

/**
 * Push-down mobile menu. Rendered as a sibling of the sticky header (normal
 * flow), so it pushes page content down instead of overlaying it. Scrollable
 * when taller than the viewport. Mirrors the desktop IA: primary links,
 * Resources, collapsible Topics, and account actions, with Courses + account
 * prominent near the top. See plans/navigation-redesign.md (Phase 9).
 */
export function MobileMenuPanel({ isOpen }: { isOpen: boolean }) {
	const pathname = usePathname()
	const current = normalize(pathname ?? '/')
	const isActive = (href: string) => normalize(href) === current

	const { data: sessionData, status: sessionStatus } = useSession()
	const { setIsFeedbackDialogOpen } = useFeedback()
	const { data: abilityRules } = api.ability.getCurrentAbilityRules.useQuery()
	const ability = createAppAbility(abilityRules || [])

	// Sidebar IA (single MDX source, resolved server-side). Lazy by design:
	// `enabled: isOpen` means a closed menu never fetches — nothing loads until
	// the visitor first opens it — and a long staleTime + no refetch-on-focus
	// keeps every reopen an instant cache hit. The resolver is itself cached
	// server-side and identical for everyone, so the request is shared too.
	const { data: mobileNav, isLoading: isNavLoading } =
		api.navigation.getMobileNav.useQuery(undefined, {
			enabled: isOpen,
			staleTime: 1000 * 60 * 30,
			gcTime: 1000 * 60 * 60,
			refetchOnMount: false,
			refetchOnWindowFocus: false,
			refetchOnReconnect: false,
		})
	const navSections = mobileNav?.sections ?? []
	const openGroups = navSections
		.filter((group) =>
			[
				...group.links,
				...(group.moreHref ? [{ href: group.moreHref }] : []),
			].some((l) => isActive(l.href)),
		)
		.map((group) => group.title)

	const isAuthed = sessionStatus === 'authenticated'
	const canViewTeam = ability.can('invite', 'Team')
	const canCreateContent = ability.can('create', 'Content')
	const canViewInvoice = ability.can('read', 'Invoice')
	const isAdmin = ability.can('manage', 'all')

	if (!isOpen) return null

	const primaryLinks = PRIMARY_NAV_ITEMS.filter(
		(item) => item.href !== COURSES_NAV_ITEM.href,
	)

	const rowClass = (href: string) =>
		cn(
			'focus-visible:ring-ring flex items-center px-5 py-2.5 text-base transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset',
			isActive(href) && 'bg-muted font-medium',
		)

	const track_ = (item: HubNavLink) =>
		track('nav_link_clicked', {
			label: item.label,
			href: item.href,
			category: 'mobile_menu',
		})

	return (
		<div
			id="mobile-menu-panel"
			className="bg-background animate-in slide-in-from-top-2 fade-in-0 max-h-[calc(100svh-var(--nav-height))] overflow-y-auto border-b duration-200 lg:hidden"
		>
			<nav
				aria-label="Mobile navigation"
				className="divide-border flex flex-col divide-y"
			>
				{/* Prominent actions */}
				<div className="grid grid-cols-2 gap-2 p-4">
					<Button asChild className="rounded-none">
						<Link href={COURSES_NAV_ITEM.href}>{COURSES_NAV_ITEM.label}</Link>
					</Button>
					{isAuthed ? (
						<Button asChild variant="outline" className="rounded-none">
							<Link href="/profile">Profile</Link>
						</Button>
					) : (
						<Button asChild variant="outline" className="rounded-none">
							<Link href="/login">Log in</Link>
						</Button>
					)}
				</div>

				{/* Primary links */}
				<ul className="flex flex-col py-2">
					<li>
						<Link
							href={PRIMARY_LEARNING_ENTRY.href}
							aria-current={
								isActive(PRIMARY_LEARNING_ENTRY.href) ? 'page' : undefined
							}
							onClick={() => track_(PRIMARY_LEARNING_ENTRY)}
							className={cn(rowClass(PRIMARY_LEARNING_ENTRY.href), 'font-semibold')}
						>
							{PRIMARY_LEARNING_ENTRY.label}
						</Link>
					</li>
					{primaryLinks.map((item) => (
						<li key={item.href}>
							<Link
								href={item.href}
								aria-current={isActive(item.href) ? 'page' : undefined}
								onClick={() => track_(item)}
								className={rowClass(item.href)}
							>
								{item.label}
							</Link>
						</li>
					))}
				</ul>

				{/* Hub sidebar IA (single MDX source via tRPC, collapsible —
				    mirrors the desktop sidebar). */}
				{isNavLoading && navSections.length === 0 ? (
					<section className="flex flex-col gap-1 py-3" aria-hidden>
						{Array.from({ length: 4 }).map((_, i) => (
							<div key={i} className="px-5">
								<SidebarMenuSkeleton />
							</div>
						))}
					</section>
				) : (
					navSections.length > 0 && (
						<section className="py-2">
							<Accordion
								type="multiple"
								defaultValue={openGroups}
								className="w-full"
							>
								{navSections.map((group) => (
									<AccordionItem
										key={group.title}
										value={group.title}
										className="border-none"
									>
										<AccordionTrigger className="px-5 py-2.5 text-base hover:no-underline">
											{group.title}
										</AccordionTrigger>
										<AccordionContent className="pb-1">
											{group.links.map((item) => (
												<Link
													key={item.href}
													href={item.href}
													aria-current={isActive(item.href) ? 'page' : undefined}
													onClick={() => track_(item)}
													className={cn(rowClass(item.href), 'py-2 pl-9 text-sm')}
												>
													{item.label}
												</Link>
											))}
											{group.moreHref && group.moreLabel && (
												<Link
													href={group.moreHref}
													aria-current={
														isActive(group.moreHref) ? 'page' : undefined
													}
													onClick={() =>
														track_({
															label: group.moreLabel!,
															href: group.moreHref!,
														})
													}
													className={cn(
														rowClass(group.moreHref),
														'text-muted-foreground py-2 pl-9 text-sm',
													)}
												>
													{group.moreLabel}
												</Link>
											)}
										</AccordionContent>
									</AccordionItem>
								))}
							</Accordion>
						</section>
					)
				)}

				{/* Account */}
				{isAuthed && (
					<ul className="flex flex-col py-2">
						{canViewInvoice && (
							<li>
								<Link href="/invoices" className={rowClass('/invoices')}>
									Invoices
								</Link>
							</li>
						)}
						{canViewTeam && !isAdmin && (
							<li>
								<Link href="/team" className={rowClass('/team')}>
									Invite Team
								</Link>
							</li>
						)}
						{canCreateContent && (
							<li>
								<Link href="/admin/pages" className={rowClass('/admin/pages')}>
									Admin
								</Link>
							</li>
						)}
						<li>
							<button
								type="button"
								onClick={() => setIsFeedbackDialogOpen(true)}
								className="hover:bg-muted focus-visible:ring-ring flex w-full items-center px-5 py-2.5 text-left text-base transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset"
							>
								Send Feedback
							</button>
						</li>
					</ul>
				)}

				{/* Footer: session action + theme */}
				<div className="flex items-center justify-between px-5 py-3">
					{isAuthed ? (
						<button
							type="button"
							onClick={() => signOut()}
							className="hover:text-foreground text-muted-foreground focus-visible:ring-ring inline-flex items-center gap-2 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2"
						>
							<ArrowRightEndOnRectangleIcon className="size-4" />
							Log out
						</button>
					) : (
						<Link
							href="/login"
							className="hover:text-foreground text-muted-foreground inline-flex items-center gap-1.5 text-sm transition-colors"
						>
							Log in
							<ChevronRight className="size-3.5" />
						</Link>
					)}
					<ThemeToggle className="text-sm [&_svg]:size-5" />
				</div>
			</nav>
		</div>
	)
}
