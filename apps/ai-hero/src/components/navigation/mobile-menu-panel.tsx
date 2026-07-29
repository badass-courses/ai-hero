'use client'

import * as React from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { createAppAbility } from '@/ability'
import { useBodyScrollLock } from '@/hooks/use-body-scroll-lock'
import { api } from '@/trpc/react'
import { track } from '@/utils/analytics'
import { ArrowRightEndOnRectangleIcon } from '@heroicons/react/24/outline'
import { ChevronRight, X } from 'lucide-react'
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
import { NAV_ICONS } from './sidebar/nav-icons'
import { normalizePath } from './sidebar/sidebar-client'
import { ThemeToggle } from './theme-toggle'

function normalize(path: string): string {
	const trimmed = path.split(/[?#]/)[0]?.replace(/\/+$/, '') || ''
	return trimmed === '' ? '/' : trimmed.toLowerCase()
}

/**
 * Mobile navigation drawer — a full-height sheet from the left, per Mobile
 * Patterns § 3b.
 *
 * It used to be a push-down panel in normal flow. A push-down cannot hold the
 * hub IA: the tree is Skills → group → 5.1, and pushing a tree that tall down
 * from the top means the reader loses the page entirely and the panel force-
 * scrolls the window to the top to compensate. The spec is explicit — "Drawer
 * is a full-height sheet from the left, not a dropdown — the tree is too tall
 * for a popover."
 *
 * Three behaviours the sheet owes the reader, all from § 3b:
 *
 * - Body scroll locks while open, and the drawer keeps its OWN scroll. See
 *   `useBodyScrollLock` and the scroll effect below.
 * - It opens scrolled to the current item rather than at the top, so a reader
 *   four levels into Skills sees where they are without hunting.
 * - Only the active branch is expanded; every sibling group stays collapsed.
 *   That is what `openGroups` + a `type="single"` Accordion already did, and it
 *   is why it stays single rather than becoming multiple.
 */
export function MobileMenuPanel({
	isOpen,
	onClose,
}: {
	isOpen: boolean
	onClose?: () => void
}) {
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
	// Only collapsible groups (topic tags / Skills / Meta) auto-open; flat
	// categories (Explore, Guides, What's New) are always visible.
	const openGroups = navSections
		.filter((group) => group.variant === 'group')
		.filter((group) =>
			[
				...group.links,
				...(group.moreHref ? [{ href: group.moreHref }] : []),
			].some((l) => isActive(l.href)),
		)
		.map((group) => group.title)

	const scrollerRef = React.useRef<HTMLElement>(null)
	// Survives close because this component stays mounted (the parent always
	// renders it and we bail on `isOpen` below) — that is what makes "the drawer
	// keeps its own scroll position" possible at all.
	const savedScrollTop = React.useRef<number | null>(null)

	useBodyScrollLock(isOpen)

	// Close on Escape — a full-height sheet that traps the page behind it needs
	// the standard way out, not only the hamburger.
	React.useEffect(() => {
		if (!isOpen || !onClose) return
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === 'Escape') onClose()
		}
		document.addEventListener('keydown', onKeyDown)
		return () => document.removeEventListener('keydown', onKeyDown)
	}, [isOpen, onClose])

	// Where the drawer lands when it opens. First open: on the current item, so
	// a reader deep in the tree sees their place. Later opens: exactly where
	// they left it. `nav` is the scroll container, so `scrollIntoView` on the
	// row would also scroll the PAGE behind the drawer — hence the manual
	// arithmetic against the container's own box.
	React.useEffect(() => {
		if (!isOpen) return
		const scroller = scrollerRef.current
		if (!scroller) return

		if (savedScrollTop.current !== null) {
			scroller.scrollTop = savedScrollTop.current
			return
		}

		const active = scroller.querySelector<HTMLElement>('[aria-current="page"]')
		if (!active) return
		// Centre it rather than top-align: the rows above a deep item are its
		// ancestors, and they are the context that makes it legible.
		const target =
			active.offsetTop - scroller.clientHeight / 2 + active.offsetHeight / 2
		scroller.scrollTop = Math.max(0, target)
	}, [isOpen, navSections.length])

	// Recorded as it happens rather than on close: the drawer unmounts its
	// contents when `isOpen` goes false, so by the time a close effect ran the
	// scroller would already be gone. This is a ref write, so it costs a number
	// and no render.
	const rememberScroll = React.useCallback(
		(event: React.UIEvent<HTMLElement>) => {
			savedScrollTop.current = event.currentTarget.scrollTop
		},
		[],
	)

	const isAuthed = sessionStatus === 'authenticated'
	const canViewTeam = ability.can('invite', 'Team')
	const canCreateContent = ability.can('create', 'Content')
	const canViewInvoice = ability.can('read', 'Invoice')
	const isAdmin = ability.can('manage', 'all')

	if (!isOpen) return null

	const primaryLinks = PRIMARY_NAV_ITEMS.filter(
		(item) => item.href !== COURSES_NAV_ITEM.href,
	)

	// 44px minimum tap height (§ 3b: `padding:11px 10px;font-size:15px`). The
	// horizontal pad is 20px rather than the spec's 10 because this drawer keeps
	// the app's own gutter, and nested rows indent from it.
	const rowClass = (href: string) =>
		cn(
			'focus-visible:ring-ring flex min-h-11 items-center px-5 py-[11px] text-[15px] transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset',
			isActive(href) && 'bg-muted font-medium',
		)

	/**
	 * The Explore rows' glyph, from the same `NAV_ICONS` map the desktop rail
	 * reads — the drawer IS that rail on a phone, and it was showing the four
	 * entries as bare text while the sidebar gave them icons. Renders nothing for
	 * hrefs with no icon, so other flat sections are unaffected.
	 */
	const NavIcon = ({ href, active }: { href: string; active: boolean }) => {
		const Icon = NAV_ICONS[normalizePath(href)]
		return Icon ? <Icon active={active} className="size-4 shrink-0" /> : null
	}

	// Small-caps category label — mirrors the desktop sidebar's `## Heading`.
	const categoryLabelClass =
		'text-muted-foreground px-5 pb-1 pt-4 text-[11px] font-semibold uppercase tracking-wider'

	const track_ = (item: HubNavLink) =>
		track('nav_link_clicked', {
			label: item.label,
			href: item.href,
			category: 'mobile_menu',
		})

	return (
		<>
			{/* Scrim. The drawer covers most of the viewport but not all of it, and
			    the uncovered strip has to be a way out or it reads as dead space. */}
			<button
				type="button"
				aria-label="Close menu"
				tabIndex={-1}
				onClick={onClose}
				className="animate-in fade-in-0 fixed inset-0 z-40 bg-black/50 duration-200 lg:hidden"
			/>
			<div
				id="mobile-menu-panel"
				className="bg-background animate-in slide-in-from-left-2 fade-in-0 fixed inset-y-0 left-0 z-50 flex w-[min(86vw,340px)] flex-col border-r duration-200 lg:hidden"
			>
				{/* Its own header row: the sheet covers the site header, so without one
				    the drawer has no close affordance of its own and the only way out
				    is the scrim. */}
				<div className="border-border flex h-(--nav-height) flex-none items-center justify-between border-b px-5">
					{/* The drawer covers the site header, so it shows the same mark
					    rather than a section eyebrow reading "Browse" — that label named
					    the sheet after one of its own sections and gave no way home. */}
					<Link
						href="/"
						onClick={onClose}
						className="text-foreground focus-visible:ring-ring rounded-[7px] text-[15.5px] font-bold leading-none tracking-[-0.01em] focus-visible:outline-none focus-visible:ring-2"
					>
						<span className="font-mono">AI</span>Hero
					</Link>
					<button
						type="button"
						onClick={onClose}
						aria-label="Close menu"
						className="text-muted-foreground hover:text-foreground focus-visible:ring-ring -mr-2 flex size-11 items-center justify-center focus-visible:outline-none focus-visible:ring-2"
					>
						<X className="size-5" />
					</button>
				</div>
				<nav
					ref={scrollerRef}
					onScroll={rememberScroll}
					aria-label="Mobile navigation"
					className="divide-border flex min-h-0 flex-1 flex-col divide-y overflow-y-auto overscroll-contain pb-[env(safe-area-inset-bottom)]"
				>
				{/* Prominent actions. `rounded-[9px]` is the app's button radius and
				    `h-11` the drawer's own 44px tap height — these were `rounded-none`,
				    the only square-cornered buttons in the product. */}
				<div className="grid grid-cols-2 gap-2 p-4">
					<Button asChild className="h-11 rounded-[9px]">
						<Link href={COURSES_NAV_ITEM.href}>{COURSES_NAV_ITEM.label}</Link>
					</Button>
					<Button asChild variant="outline" className="h-11 rounded-[9px]">
						<Link href={isAuthed ? '/profile' : '/login'}>
							{isAuthed ? 'Profile' : 'Log in'}
						</Link>
					</Button>
				</div>

				{/* Hub sidebar IA — the SAME MDX source as the desktop sidebar,
				    resolved server-side. Two tiers mirror the desktop / Amy's mobile
				    wireframe: flat categories (Explore, Guides, What's New) show their
				    links inline; a bare category label (Topics) heads the collapsible
				    topic groups that follow it. */}
				{isNavLoading && navSections.length === 0 ? (
					<section className="flex flex-col gap-1 py-3" aria-hidden>
						{Array.from({ length: 4 }).map((_, i) => (
							<div key={i} className="px-5">
								<SidebarMenuSkeleton />
							</div>
						))}
					</section>
				) : navSections.length > 0 ? (
					<section className="pb-2">
						{navSections.map((section, index) => {
							if (section.variant === 'category') {
								return (
									<div
										key={section.title}
										className={cn(
											categoryLabelClass,
											index > 0 && 'border-border mt-1 border-t',
										)}
									>
										{section.title}
									</div>
								)
							}

							if (section.variant === 'flat') {
								return (
									<div
										key={section.title}
										className={cn(index > 0 && 'border-border border-t')}
									>
										<div className={categoryLabelClass}>{section.title}</div>
										<ul className="flex flex-col">
											{section.links.map((item) => (
												<li key={item.href}>
													<Link
														href={item.href}
														aria-current={isActive(item.href) ? 'page' : undefined}
														onClick={() => track_(item)}
														className={cn(rowClass(item.href), 'gap-2.5')}
													>
														<NavIcon href={item.href} active={isActive(item.href)} />
														{item.label}
													</Link>
												</li>
											))}
											{section.moreHref && section.moreLabel && (
												<li>
													<Link
														href={section.moreHref}
														onClick={() =>
															track_({
																label: section.moreLabel!,
																href: section.moreHref!,
															})
														}
														className={cn(
															rowClass(section.moreHref),
															'text-muted-foreground',
														)}
													>
														{section.moreLabel}
													</Link>
												</li>
											)}
										</ul>
									</div>
								)
							}

							// Collapsible group (topic tag / Skills / Meta).
							return (
								<Accordion
									key={section.title}
									type="single"
									collapsible
									defaultValue={
										openGroups.includes(section.title) ? section.title : undefined
									}
									className="w-full"
								>
									<AccordionItem value={section.title} className="border-none">
										<AccordionTrigger className="px-5 py-2.5 text-[15px] hover:no-underline">
											{section.title}
										</AccordionTrigger>
										<AccordionContent className="pb-1">
											{section.links.map((item) => (
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
											{section.moreHref && section.moreLabel && (
												<Link
													href={section.moreHref}
													aria-current={
														isActive(section.moreHref) ? 'page' : undefined
													}
													onClick={() =>
														track_({
															label: section.moreLabel!,
															href: section.moreHref!,
														})
													}
													className={cn(
														rowClass(section.moreHref),
														'text-muted-foreground py-2 pl-9 text-sm',
													)}
												>
													{section.moreLabel}
												</Link>
											)}
										</AccordionContent>
									</AccordionItem>
								</Accordion>
							)
						})}
					</section>
				) : (
					// IA resolved but empty (degraded CMS edit) — keep navigation alive
					// with the static primary destinations.
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
		</>
	)
}
