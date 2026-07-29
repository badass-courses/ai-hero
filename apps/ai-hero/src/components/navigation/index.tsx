'use client'

import * as React from 'react'
import Image from 'next/image'
import Link from 'next/link'
import { useParams, usePathname, useRouter } from 'next/navigation'
import { api } from '@/trpc/react'
import { track } from '@/utils/analytics'
import { useSession } from 'next-auth/react'

import { useFeedback } from '@coursebuilder/ui/feedback-widget/feedback-context'
import { cn } from '@coursebuilder/utils/cn'

import { SearchPalette } from '../search-palette/search-palette'
import { MobileMenuPanel } from './mobile-menu-panel'
import { MobileNavigation } from './mobile-navigation'
import { NavLinkItem } from './nav-link-item'
import { useCohortOffer } from './nav-cta-context'
import { getNavMode } from './nav-mode'
import { NavPill, navTextLink } from './nav-pill'
import {
	COURSES_NAV_ITEM,
	PRIMARY_LEARNING_ENTRY,
	PRIMARY_NAV_ITEMS,
} from './primary-nav'
import { UserMenu } from './user-menu'

/**
 * Session-dependent nav items that use mounted state to prevent hydration mismatch.
 * By deferring render until after hydration, we ensure consistent tree structure.
 */
const SessionDependentNavItems = ({
	sessionStatus,
	subscriber,
	setIsFeedbackDialogOpen,
}: {
	sessionStatus: 'loading' | 'authenticated' | 'unauthenticated'
	subscriber: unknown
	setIsFeedbackDialogOpen: (open: boolean) => void
}) => {
	const [mounted, setMounted] = React.useState(false)

	React.useEffect(() => {
		setMounted(true)
	}, [])

	// The Newsletter link renders from SSR on purpose — see below. Only the
	// session-dependent Feedback item waits for mount, because `sessionStatus`
	// genuinely differs between server and client and would mismatch.
	return (
		<>
			{mounted && sessionStatus === 'authenticated' && (
				<li className="hidden items-center lg:flex">
					<button
						type="button"
						onClick={() => setIsFeedbackDialogOpen(true)}
						className={navTextLink}
					>
						Feedback
					</button>
				</li>
			)}
			{/* No mount gate. `subscriber` is `undefined` on the server AND on the
			    first client render (the tRPC query has not resolved), so `!subscriber`
			    agrees across hydration and this is safe to SSR. Behind the gate it
			    appeared only after mount and shoved the whole cluster 78px left on
			    every page load. Now the only movement is for people who turn out to
			    be subscribed, once, when the query lands. */}
			{!subscriber && (
				<li className="hidden items-center lg:flex">
					<Link
						prefetch
						href="/newsletter"
						onClick={() => {
							track('nav_link_clicked', {
								label: 'Newsletter',
								href: '/newsletter',
							})
						}}
						className={navTextLink}
					>
						Newsletter
					</Link>
				</li>
			)}
		</>
	)
}

/**
 * Emphasized primary learning entry ("Start Here"). Carries a persistent
 * highlight so it reads as the lead destination, separate from active state —
 * but it yields that highlight whenever another bar item IS the current page.
 * The pill it renders is the same one `NavLinkItem` uses for "you are here", so
 * on /courses the reader saw two identical highlights and no way to tell which
 * one meant "you are here".
 */
const PrimaryEntryLink = ({
	isActive,
	highlighted,
}: {
	isActive: boolean
	highlighted: boolean
}) => (
	<li className="flex items-center">
		<Link
			prefetch
			href={PRIMARY_LEARNING_ENTRY.href}
			onClick={() => {
				track('nav_link_clicked', {
					label: PRIMARY_LEARNING_ENTRY.label,
					href: PRIMARY_LEARNING_ENTRY.href,
				})
			}}
			aria-current={isActive ? 'page' : undefined}
			className="group/nav-item focus-visible:ring-ring text-[color:var(--ah-fg-muted)] relative flex items-center rounded-[7px] focus-visible:outline-none focus-visible:ring-2"
		>
			<NavPill active={highlighted || undefined} className="font-medium">
				{PRIMARY_LEARNING_ENTRY.label}
			</NavPill>
		</Link>
	</li>
)

/**
 * The one gold action in the bar, as a ladder rather than a fixed link:
 *
 * 1. **Not on the free course** → "Get the free course". This outranks
 *    everything. The 7-day course is the front door, and someone who has not
 *    walked through it should not be asked for a paid cohort first.
 * 2. **On the free course** → the cohort: "Join the cohort" when one is
 *    purchasable, "Join the waitlist" between cohorts.
 * 3. **Nothing left to offer** → nothing. Never sell someone what they have.
 *
 * The cohort half comes from {@link getCohortOffer} via context — the same
 * selector `CourseCta` uses at the foot of an article, so the bar and the
 * article can never disagree about whether enrollment is open. It is resolved
 * on the server and is therefore correct in the first paint.
 *
 * `state === 'active'` is the same test `/skills/subscribe` uses to choose
 * between its "subscribed" and "show-form" views, off the same
 * `getSubscriberFromCookie`. Anything looser (a truthy subscriber record) would
 * also promote unconfirmed and cancelled subscribers past the free course.
 */
const FreeCourseCta = ({
	pathname,
	subscriber,
}: {
	pathname: string
	subscriber: unknown
}) => {
	const cohortOffer = useCohortOffer()

	// `undefined` while the query is in flight. Treated as "not subscribed" so
	// the free course renders from the first paint — the common case, and the
	// step that takes precedence anyway, so nothing swaps for most visitors.
	const isSubscribed =
		Boolean(subscriber) &&
		typeof subscriber === 'object' &&
		subscriber !== null &&
		'state' in subscriber &&
		subscriber.state === 'active'

	// The free course is the front door and outranks everything: someone who has
	// not taken it is asked for that, cohort or no cohort. Only once they are on
	// the list does the bar move them up the ladder to the cohort — enroll when
	// one is purchasable, waitlist between cohorts.
	const offer = !isSubscribed
		? { label: 'Get the free course', href: '/skills/subscribe' }
		: cohortOffer
			? { label: cohortOffer.label, href: cohortOffer.href }
			: null

	if (!offer) return null
	// Never sell the page you are standing on.
	if (pathname.startsWith(offer.href)) return null

	return (
		<li className="hidden items-center lg:flex">
			<Link
				prefetch
				href={offer.href}
				onClick={() => {
					track('nav_link_clicked', {
						label: offer.label,
						href: offer.href,
					})
				}}
				// `min-w` holds the slot at the widest label so the bar's geometry is
				// fixed from first paint — swapping "Get the free course" for "Join the
				// waitlist" when the subscriber query lands must not reflow the row.
				className="bg-accent-fill text-accent-fill-foreground hover:bg-accent-fill-hover focus-visible:ring-ring inline-flex min-w-[152px] items-center justify-center rounded-[8px] px-3.5 py-2 text-[13px] font-bold leading-none transition focus-visible:outline-none focus-visible:ring-2"
			>
				{offer.label}
			</Link>
		</li>
	)
}

const Navigation = () => {
	const pathname = usePathname()
	const mode = getNavMode(pathname)
	const isRoot = pathname === '/'
	const params = useParams()
	const router = useRouter()
	const { setIsFeedbackDialogOpen } = useFeedback()

	const [isMobileMenuOpen, setIsMobileMenuOpen] = React.useState(false)
	const [isSearchOpen, setIsSearchOpen] = React.useState(false)

	React.useEffect(() => {
		setIsMobileMenuOpen(false)
	}, [pathname])

	const { data: sessionData, status: sessionStatus } = useSession()
	const { data: subscriber } =
		api.ability.getCurrentSubscriberFromCookie.useQuery()

	// Center destinations by mode. `minimal` (editors/admin/auth) shows none.
	const showSearch = mode === 'full' || mode === 'hub'

	return (
		<>
			<header
				className={cn(
					// 44px gutter and a translucent, blurred bar, per the redesign
					// spec. Height comes from `--nav-height` so every
					// `calc(100vh - var(--nav-height))` consumer stays in step.
					'bg-background/90 h-(--nav-height) relative z-50 flex w-full items-center gap-5 border-b px-[18px] backdrop-blur-md print:hidden lg:px-11',
					{
						'sticky top-0': !params.lesson,
					},
				)}
			>
				<span
					className="flex shrink-0 items-center"
					onContextMenu={(e) => {
						e.preventDefault()
						router.push('/brand')
					}}
				>
					<Link
						prefetch
						tabIndex={isRoot ? -1 : 0}
						href="/"
						aria-label="AI Hero home"
						className="group focus-visible:ring-ring flex items-center gap-2.5 rounded-[7px] leading-none transition focus-visible:outline-none focus-visible:ring-2"
					>
						{/* Brand mark: the cut-out portrait standing on the bar's bottom
						    edge at the bar's full height, not a cropped circle. The
						    silhouette IS the mark — putting it in a disc throws away the
						    shoulders and leaves a generic avatar. `w-auto` keeps the
						    aspect and `object-bottom` keeps it standing on the rule. */}
						<Image
							src="/matt-pocock-navigation-avatar@2x.png"
							alt=""
							width={124}
							height={124}
							priority
							className="h-(--nav-height) w-auto shrink-0 object-contain object-bottom"
						/>
						<span className="text-foreground text-[15.5px] font-bold leading-none tracking-[-0.01em]">
							<span className="font-mono">AI</span>Hero
						</span>
					</Link>
				</span>
				{mode !== 'minimal' && (
					<nav
						className="hidden items-center lg:flex"
						aria-label="Primary navigation"
					>
						<ul className="flex items-center gap-0.5">
							{mode === 'full' ? (
								<>
									<PrimaryEntryLink
										isActive={pathname === PRIMARY_LEARNING_ENTRY.href}
										highlighted={
											pathname === PRIMARY_LEARNING_ENTRY.href ||
											!PRIMARY_NAV_ITEMS.some(
												(item) => pathname === item.href.replace(/\/$/, ''),
											)
										}
									/>
									{PRIMARY_NAV_ITEMS.map((item) => (
										<NavLinkItem
											key={item.href}
											href={item.href}
											label={item.label}
											textLabel={item.label}
										/>
									))}
								</>
							) : (
								// Hub mode (per Amy's decisions doc): the sidebar carries
								// Map/Principles/Skills/Tools; the top bar keeps only the
								// persistent revenue path.
								<NavLinkItem
									href={COURSES_NAV_ITEM.href}
									label={COURSES_NAV_ITEM.label}
									textLabel={COURSES_NAV_ITEM.label}
								/>
							)}
						</ul>
					</nav>
				)}
				<nav
					className="ml-auto hidden items-center lg:flex"
					aria-label="User navigation"
				>
					<ul className="flex items-center gap-[18px]">
						{showSearch && (
							<li className="flex items-center">
								<button
									type="button"
									onClick={() => {
										track('search_palette_opened', { via: 'nav_icon' })
										setIsSearchOpen(true)
									}}
									className={cn(navTextLink, isSearchOpen && 'text-foreground')}
								>
									Search
								</button>
							</li>
						)}
						<SessionDependentNavItems
							sessionStatus={sessionStatus}
							subscriber={subscriber}
							setIsFeedbackDialogOpen={setIsFeedbackDialogOpen}
						/>
						<UserMenu />
						{mode !== 'minimal' && (
							<FreeCourseCta pathname={pathname} subscriber={subscriber} />
						)}
					</ul>
				</nav>
				<MobileNavigation
					isMobileMenuOpen={isMobileMenuOpen}
					setIsMobileMenuOpen={setIsMobileMenuOpen}
					onSearchOpen={() => setIsSearchOpen(true)}
					subscriber={subscriber}
					// The same flag that gates the palette below and the desktop
					// Search link above — otherwise the mobile glyph renders on
					// `minimal` routes and toggles state nothing is listening to.
					showSearch={showSearch}
				/>
			</header>
			<MobileMenuPanel
				isOpen={isMobileMenuOpen}
				onClose={() => setIsMobileMenuOpen(false)}
			/>
			{showSearch && (
				<SearchPalette open={isSearchOpen} onOpenChange={setIsSearchOpen} />
			)}
		</>
	)
}

export default Navigation
