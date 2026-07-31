'use client'

import * as React from 'react'
import dynamic from 'next/dynamic'
import Image from 'next/image'
import Link from 'next/link'
import { useParams, usePathname, useRouter } from 'next/navigation'
import { useCtaGate } from '@/hooks/use-cta-gate'
import { hasJoinedOfferWaitlist, isOnEmailList } from '@/lib/cta-gating'
import type { Subscriber } from '@/schemas/subscriber'
import type { CtaGatingSubscriber } from '@/lib/cta-gating'
import { api } from '@/trpc/react'
import { track } from '@/utils/analytics'
import { useSession } from 'next-auth/react'

import { useFeedback } from '@coursebuilder/ui/feedback-widget/feedback-context'
import { cn } from '@coursebuilder/utils/cn'

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
 * Both of these render nothing until the visitor asks for them — the palette is
 * closed until ⌘K or the Search link, the drawer until the hamburger — and both
 * are heavy: the palette drags in cmdk and the whole radix dialog, the drawer an
 * accordion, a focus trap and the nav icon set. `Navigation` sits in the root
 * layout, so statically importing them put all of that in the chunk EVERY page
 * loads before it can hydrate anything.
 *
 * Loaded on first open instead. No `ssr: false`: neither renders server markup
 * while closed, so there is nothing to suppress, and keeping SSR on means a
 * palette opened before hydration still works.
 */
const SearchPalette = dynamic(() =>
	import('../search-palette/search-palette').then((mod) => mod.SearchPalette),
)

const MobileMenuPanel = dynamic(() =>
	import('./mobile-menu-panel').then((mod) => mod.MobileMenuPanel),
)

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
	subscriber: CtaGatingSubscriber | null | undefined
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
			    first client render (the tRPC query has not resolved), so this test
			    agrees across hydration and is safe to SSR. Behind the gate it
			    appeared only after mount and shoved the whole cluster 78px left on
			    every page load. Now the only movement is for people who turn out to
			    be subscribed, once, when the query lands.

			    `isOnEmailList` rather than a truthy record, matching the gold CTA
			    below and every other ask on the site: an unconfirmed subscriber is
			    someone the newsletter link should still reach. */}
			{!isOnEmailList(subscriber) && (
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
 * 2. **On the free course** → whatever `getNextOffer` says is the best ask
 *    right now: a live sale on anything ("Save 30%"), else a purchasable
 *    cohort, else the unreleased workshop's waitlist, else the next cohort's.
 *    The bar used to know only about cohorts, so a sale on a standalone
 *    workshop — or the workshop itself — could not appear here at all.
 * 3. **Nothing left to offer** → nothing. Never sell someone what they have.
 *
 * Step 3 used to be reachable only by running out of cohorts, which meant the
 * two people with the strongest claim to it never got there: someone who
 * bought the cohort was still told to join it, and someone who signed up for
 * the waitlist was still asked to sign up for the waitlist, on every page,
 * indefinitely. Both are now rungs the ladder can pass.
 *
 * The offer comes from `getNextOffer` via context — the same selector
 * `CourseCta` uses at the foot of an article, so the bar and the article can
 * never disagree about what is being sold today. It is resolved on the server
 * and is therefore correct in the first paint.
 *
 * The subscriber tests are the shared predicates in `lib/cta-gating`, the same
 * ones every other ask on the site is gated on, so the bar and the page under
 * it can never disagree about who has already done what. `isOnEmailList` in
 * particular is `state === 'active'`: anything looser would promote unconfirmed
 * and cancelled subscribers past the free course they never actually started.
 */
const FreeCourseCta = ({
	pathname,
	subscriber,
	subscriberResolved,
}: {
	pathname: string
	subscriber: CtaGatingSubscriber | null | undefined
	/** False while the gate query is still in flight — see the hold below. */
	subscriberResolved: boolean
}) => {
	const cohortOffer = useCohortOffer()

	// The SAME answer `/skills/subscribe` and the inline CTA use, so the bar
	// cannot advertise a course the page then refuses to offer.
	//
	// This was `isOnEmailList(subscriber)`, which is wrong twice. It reads
	// `state === 'active'` — being on the AI HERO LIST, which this codebase
	// states plainly is not being on the course (see `hasStartedFreeCourse`), so
	// a subscriber who had never joined was never asked. And it read a
	// cookie-only payload while the subscribe page also falls back to Kit, so
	// the bar could say "not subscribed" over a page that had already concluded
	// the opposite: the button offered a course and led to a page with no form.
	const { data: courseCta, isPending: courseCtaPending } =
		api.ability.getSkillsCourseCtaState.useQuery()
	const isSubscribed = courseCta?.state === 'subscribed'

	const { status: sessionStatus } = useSession()

	// Does this reader already own what the ladder is about to offer them?
	//
	// `!== 'unauthenticated'` rather than `=== 'authenticated'`. The root
	// `SessionProvider` is not seeded from the server — it cannot be, without an
	// `auth()` call in the root layout making all hundred prerendered routes
	// dynamic — so `sessionStatus` is `loading` on first render. Waiting for
	// `authenticated` therefore delays this query behind the session request and
	// gives the bar a THIRD state to settle through. Firing while the session is
	// still unknown costs a query that occasionally turns out to be unnecessary;
	// waiting costs every signed-in reader a visible flicker.
	//
	// Signed-out readers are excluded once we know that, which is the case worth
	// excluding: they are most of the traffic and they own nothing.
	//
	// It is NOT gated on `isSubscribed`, which would be the obvious saving —
	// that waits on the gate query, so it would put this behind a request that
	// has to land first and give the bar yet another state to settle through.
	const ownershipAsked =
		Boolean(cohortOffer?.id) && sessionStatus !== 'unauthenticated'

	const { data: ownership, isPending: ownershipPending } =
		api.ability.ownsResource.useQuery(
			{ resourceId: cohortOffer?.id ?? '' },
			{
				enabled: ownershipAsked,
				staleTime: 5 * 60 * 1000,
				refetchOnWindowFocus: false,
				// One retry, not react-query's default three. A failed ownership
				// check falls back to showing the offer, which is the safe direction
				// — and three retries with exponential backoff meant a flaky
				// response re-rendered this button four times over several seconds,
				// long after the page had otherwise settled.
				retry: 1,
			},
		)

	// A waitlist is the one thing on this ladder you can be finished with
	// without buying anything, and the offer says which waitlist it is — the
	// next cohort's, or the unreleased workshop's. The field comes off the same
	// subscriber record the rung above reads, so this costs nothing extra.
	const alreadyWaiting = hasJoinedOfferWaitlist(subscriber, cohortOffer?.waitlist)

	// The free course is the front door and outranks everything: someone who has
	// not taken it is asked for that, cohort or no cohort. Only once they are on
	// the list does the bar move them up the ladder to the cohort — enroll when
	// one is purchasable, waitlist between cohorts — and past that too, once
	// they own the cohort or are already waiting for it.
	const cohortSettled = ownership?.owned === true || alreadyWaiting
	const offer = !isSubscribed
		? { label: 'Get the free course', href: '/skills/subscribe' }
		: cohortOffer && !cohortSettled
			? { label: cohortOffer.label, href: cohortOffer.href }
			: null

	// Hold the slot rather than guess at it.
	//
	// This used to render "Get the free course" while the subscriber query was
	// in flight, on the reasoning that most visitors are not subscribed so most
	// of the time the guess is right. But the bar's one gold button is the most
	// looked-at thing in the header, and for everyone it was wrong about — every
	// subscriber, on every page — it announced the wrong offer and then swapped
	// it out from under them. A button whose text changes after you have started
	// reading it is worse than a button that arrives a moment late.
	//
	// `min-w` already pinned the geometry, so this costs no layout shift; it is
	// the same box, held blank until it can be honest. Ownership is waited on
	// too, but only when it was actually asked for — a disabled query reports
	// `isPending` forever, which would leave a signed-out visitor staring at a
	// placeholder that never resolves.

	// `courseCtaPending` joins the hold for the reason above it: the label is now
	// decided by that query, so rendering before it lands would put "Get the free
	// course" in front of someone already taking it and then swap it — the exact
	// flicker this hold exists to prevent.
	if (
		!subscriberResolved ||
		courseCtaPending ||
		(ownershipAsked && ownershipPending)
	) {
		return (
			<li className="hidden items-center lg:flex">
				<span
					aria-hidden
					className="bg-foreground/[0.06] inline-flex min-w-[152px] items-center justify-center rounded-[8px] px-3.5 py-2 text-[13px] font-bold leading-none"
				>
					{/* A non-breaking space, not an empty box: it gives the placeholder
					    the same line box as the label it stands in for, so the two are
					    the same height without that height being written down twice. */}
					&nbsp;
				</span>
			</li>
		)
	}

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

	// Both overlays close on navigation. The palette closes itself on select,
	// but a route change it did not cause — browser back/forward, a link in the
	// promo row's own page — used to leave `isSearchOpen` true underneath it.
	// On a `minimal` route the gate below unmounts the palette without touching
	// that state, so the next full/hub page mounted it open and the modal
	// appeared unprompted.
	React.useEffect(() => {
		setIsMobileMenuOpen(false)
		setIsSearchOpen(false)
	}, [pathname])

	const { data: sessionData, status: sessionStatus } = useSession()
	// The gating read, not the full one. This runs in the root layout on every
	// page in the site, and the full read re-fetches the subscriber from Kit
	// whenever the cookie is partial — a third-party round-trip per navigation
	// to decide which label a single button carries.
	const { subscriber, isResolved: subscriberResolved } = useCtaGate()

	// Center destinations by mode. `minimal` (editors/admin/auth) shows none.
	const showSearch = mode === 'full' || mode === 'hub'

	// Both panels are `next/dynamic`, and a dynamic import only defers anything
	// if the element is not rendered — so they are not rendered until the first
	// time they are asked for, and stay mounted afterwards. Staying mounted is
	// load-bearing for the drawer: it is what remembers the reader's place in the
	// nav tree between opens.
	const [hasOpenedSearch, setHasOpenedSearch] = React.useState(false)
	const [hasOpenedMenu, setHasOpenedMenu] = React.useState(false)

	React.useEffect(() => {
		if (isSearchOpen) setHasOpenedSearch(true)
	}, [isSearchOpen])

	React.useEffect(() => {
		if (isMobileMenuOpen) setHasOpenedMenu(true)
	}, [isMobileMenuOpen])

	// ⌘K lives HERE rather than inside the palette, because the palette is no
	// longer mounted before its first open — a shortcut that only works once the
	// component it opens is already on the page is not a shortcut.
	React.useEffect(() => {
		if (!showSearch) return
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === 'k' && (event.metaKey || event.ctrlKey)) {
				event.preventDefault()
				setIsSearchOpen((open) => {
					if (!open) track('search_palette_opened', { via: 'keyboard' })
					return !open
				})
			}
		}
		document.addEventListener('keydown', onKeyDown)
		return () => document.removeEventListener('keydown', onKeyDown)
	}, [showSearch])

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
							// `useCohortOffer` unwraps the root layout's promise with
							// `use()`, so this suspends until the offer lands. The fallback
							// is nothing: the CTA reserves its own width via `min-w`, and an
							// absent gold button reads better for one beat than a skeleton
							// of one.
							<React.Suspense fallback={null}>
								<FreeCourseCta
								pathname={pathname}
								subscriber={subscriber}
								subscriberResolved={subscriberResolved}
							/>
							</React.Suspense>
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
			{hasOpenedMenu && (
				<MobileMenuPanel
					isOpen={isMobileMenuOpen}
					onClose={() => setIsMobileMenuOpen(false)}
					mode={mode}
				/>
			)}
			{showSearch && hasOpenedSearch && (
				// Same reason as the CTA above: the palette reads the cohort offer for
				// its promo row and therefore suspends on first open. By then the
				// promise has almost always settled — it was started in the root
				// layout, before this page rendered.
				<React.Suspense fallback={null}>
					<SearchPalette open={isSearchOpen} onOpenChange={setIsSearchOpen} />
				</React.Suspense>
			)}
		</>
	)
}

export default Navigation
