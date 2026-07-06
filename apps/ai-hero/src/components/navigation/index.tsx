'use client'

import * as React from 'react'
import Image from 'next/image'
import Link from 'next/link'
import { useParams, usePathname, useRouter } from 'next/navigation'
import { api } from '@/trpc/react'
import { track } from '@/utils/analytics'
import { Search } from 'lucide-react'
import { useSession } from 'next-auth/react'

import { useFeedback } from '@coursebuilder/ui/feedback-widget/feedback-context'
import { cn } from '@coursebuilder/utils/cn'

import { SearchPalette } from '../search-palette/search-palette'
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from '../ui/tooltip'
import { MobileMenuPanel } from './mobile-menu-panel'
import { MobileNavigation } from './mobile-navigation'
import { NavLinkItem } from './nav-link-item'
import { getNavMode } from './nav-mode'
import { NavPill } from './nav-pill'
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

	// Return nothing during SSR and initial hydration to keep tree consistent
	if (!mounted) {
		return null
	}

	return (
		<>
			{sessionStatus === 'authenticated' && (
				<NavLinkItem
					className="hidden font-normal lg:flex"
					label="Feedback"
					onClick={() => {
						setIsFeedbackDialogOpen(true)
					}}
				/>
			)}
			{sessionStatus === 'unauthenticated' && !subscriber && (
				<NavLinkItem
					href="/newsletter"
					className="rounded-none [&_span]:flex [&_span]:items-center"
					label={
						<>
							<svg
								xmlns="http://www.w3.org/2000/svg"
								className="mr-1 size-4"
								fill="none"
								viewBox="0 0 24 24"
							>
								<path
									stroke="currentColor"
									strokeLinecap="round"
									strokeLinejoin="round"
									strokeWidth="1.5"
									d="M6 8h8m-8 4h8m-8 4h4m8-8h1c1.414 0 2.121 0 2.56.44.44.439.44 1.146.44 2.56v8a2 2 0 1 1-4 0V8Z"
								/>
								<path
									stroke="currentColor"
									strokeLinecap="round"
									strokeLinejoin="round"
									strokeWidth="1.5"
									d="M12 3H8c-2.828 0-4.243 0-5.121.879C2 4.757 2 6.172 2 9v6c0 2.828 0 4.243.879 5.121C3.757 21 5.172 21 8 21h12a2 2 0 0 1-2-2V9c0-2.828 0-4.243-.879-5.121C16.243 3 14.828 3 12 3Z"
								/>
							</svg>
							Newsletter
						</>
					}
				/>
			)}
		</>
	)
}

/**
 * Emphasized primary learning entry ("Start Here"). Carries a persistent
 * highlight so it reads as the lead destination, separate from active state.
 */
const PrimaryEntryLink = ({ isActive }: { isActive: boolean }) => (
	<li className="flex items-stretch">
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
			className="group/nav-item focus-visible:ring-ring relative flex h-full items-center px-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset"
		>
			<NavPill active className="font-semibold">
				{PRIMARY_LEARNING_ENTRY.label}
			</NavPill>
		</Link>
	</li>
)

/**
 * Icon-only search affordance opening the ⌘K palette, with a designed
 * tooltip. The pill highlights while the palette is open.
 */
const SearchIconButton = ({
	isSearchOpen,
	onOpen,
}: {
	isSearchOpen: boolean
	onOpen: () => void
}) => (
	<li className="hidden items-stretch lg:flex">
		<TooltipProvider delayDuration={200}>
			<Tooltip>
				<TooltipTrigger asChild>
					<button
						type="button"
						aria-label="Search"
						onClick={() => {
							track('search_palette_opened', { via: 'nav_icon' })
							onOpen()
						}}
						className="group/nav-item focus-visible:ring-ring flex h-full items-center px-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset"
					>
						<NavPill active={isSearchOpen} className="px-2">
							<Search aria-hidden className="size-4" />
						</NavPill>
					</button>
				</TooltipTrigger>
				<TooltipContent className="rounded-none">
					Search <kbd className="font-mono">⌘K</kbd>
				</TooltipContent>
			</Tooltip>
		</TooltipProvider>
	</li>
)

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
					'bg-background/90 h-(--nav-height) relative z-50 flex w-full items-stretch justify-between border-b px-0 backdrop-blur-md print:hidden',
					{
						'sticky top-0': !params.lesson,
					},
				)}
			>
			<div className="flex w-full items-stretch justify-between">
				<div className="flex items-stretch">
					<span
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
							className="font-heading h-(--nav-height) group focus-visible:ring-ring flex w-full items-center justify-center gap-2 pl-3 pr-3 text-lg font-semibold leading-none transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset"
						>
							{/* Brand mark: fills the full nav height — no vertical padding
							    (the 124px @2x asset is cut for the 63px bar). */}
							<Image
								src="/matt-pocock-navigation-avatar@2x.png"
								alt="Matt Pocock"
								width={124}
								height={124}
								priority
								className="h-(--nav-height) w-auto shrink-0 self-end object-contain object-bottom"
							/>
							<span className="text-foreground leading-none! text-lg font-semibold tracking-tight">
								<span className="font-mono">AI</span>Hero
							</span>
						</Link>
					</span>
					{mode !== 'minimal' && (
						<nav
							className="hidden items-stretch lg:flex"
							aria-label="Primary navigation"
						>
							<ul className="flex items-stretch">
								{mode === 'full' ? (
									<>
										<PrimaryEntryLink
											isActive={pathname === PRIMARY_LEARNING_ENTRY.href}
										/>
										{PRIMARY_NAV_ITEMS.map((item) => (
											<NavLinkItem
												key={item.href}
												href={item.href}
												label={item.label}
												textLabel={item.label}
												className="font-normal"
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
										className="font-normal"
									/>
								)}
							</ul>
						</nav>
					)}
				</div>
				<nav className="flex items-stretch" aria-label="User navigation">
					<ul className="hidden items-stretch lg:flex">
						{showSearch && (
							<SearchIconButton
								isSearchOpen={isSearchOpen}
								onOpen={() => setIsSearchOpen(true)}
							/>
						)}
						<SessionDependentNavItems
							sessionStatus={sessionStatus}
							subscriber={subscriber}
							setIsFeedbackDialogOpen={setIsFeedbackDialogOpen}
						/>
						<UserMenu />
					</ul>
				</nav>
				<MobileNavigation
					isMobileMenuOpen={isMobileMenuOpen}
					setIsMobileMenuOpen={setIsMobileMenuOpen}
					onSearchOpen={() => setIsSearchOpen(true)}
					subscriber={subscriber}
				/>
			</div>
			</header>
			<MobileMenuPanel isOpen={isMobileMenuOpen} />
			{showSearch && (
				<SearchPalette open={isSearchOpen} onOpenChange={setIsSearchOpen} />
			)}
		</>
	)
}

export default Navigation
