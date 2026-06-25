'use client'

import * as React from 'react'
import Link from 'next/link'
import { useParams, usePathname, useRouter } from 'next/navigation'
import { createAppAbility } from '@/ability'
import { useSaleToastNotifier } from '@/hooks/use-sale-toast-notifier'
import { api } from '@/trpc/react'
import { track } from '@/utils/analytics'
import { ChevronDown, ChevronRight, Menu, Newspaper, X } from 'lucide-react'
import { useSession } from 'next-auth/react'

import {
	NavigationMenu,
	NavigationMenuContent,
	NavigationMenuItem,
	NavigationMenuLink,
	NavigationMenuList,
	NavigationMenuTrigger,
} from '@coursebuilder/ui'
import { useFeedback } from '@coursebuilder/ui/feedback-widget/feedback-context'
import { cn } from '@coursebuilder/utils/cn'

import { LogoMark } from '../brand/logo'
import { AiHeroMascot } from '../brand/mascot'
import { CldImage } from '../cld-image'
import { ResourceHoverFrame } from '../resource-hover-frame'
import { MobileNavigation } from './mobile-navigation'
import { NavLinkItem } from './nav-link-item'
import { navLinkReset, NavPill, navTriggerReset } from './nav-pill'
import { ThemeToggle } from './theme-toggle'
import { useLiveEventToastNotifier } from './use-live-event-toast-notifier'
import type {
	CourseItem,
	FeaturedTutorial,
	TutorialItem,
} from './use-nav-links'
import { useNavLinks } from './use-nav-links'
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

const Navigation = () => {
	const navData = useNavLinks()
	const pathname = usePathname()
	const isRoot = pathname === '/'
	const isEditRoute = pathname.includes('/edit')
	const params = useParams()
	const router = useRouter()
	const { setIsFeedbackDialogOpen } = useFeedback()

	const isLessonRoute = params.lesson && params.module

	const [isMobileMenuOpen, setIsMobileMenuOpen] = React.useState(false)

	// useLiveEventToastNotifier()
	// useSaleToastNotifier()

	React.useEffect(() => {
		setIsMobileMenuOpen(false)
	}, [pathname])

	const { data: sessionData, status: sessionStatus } = useSession()
	const { data: subscriber, status } =
		api.ability.getCurrentSubscriberFromCookie.useQuery()

	const navSubheadingClassName = 'opacity-90 px-3 pt-3 text-sm'

	return (
		<header
			className={cn(
				'bg-background/90 h-(--nav-height) relative z-50 flex w-full items-stretch justify-between border-b px-0 backdrop-blur-md print:hidden',
				{
					'sticky top-0': !params.lesson,
				},
			)}
		>
			<div className={cn('flex w-full items-stretch justify-between', {})}>
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
							className="font-heading h-(--nav-height) group flex w-full items-center justify-center gap-2 px-5 pr-2 text-lg font-semibold leading-none transition"
						>
							<LogoMark className="w-7" />
							{/* <AiHeroMascot size={48} className="-my-2" /> */}
							<span className="text-foreground leading-none! text-lg font-semibold tracking-tight">
								<span className="font-mono">AI</span>Hero
							</span>
						</Link>
					</span>
					{/* <hr
						aria-hidden="true"
						className="bg-border my-auto flex h-full w-px"
					/> */}
					<NavigationMenu
						viewport={true}
						className="**:data-[slot=navigation-menu-viewport]:rounded-none **:data-[slot=navigation-menu-viewport]:mt-0 **:data-[slot=navigation-menu-viewport]:shadow-2xl **:data-[slot=navigation-menu-viewport]:duration-200 **:data-[slot=navigation-menu-viewport]:ease-out-quart **:data-[slot=navigation-menu-viewport]:data-[state=open]:zoom-in-[0.97] **:data-[slot=navigation-menu-viewport]:data-[state=closed]:zoom-out-[0.97] **:data-[slot=navigation-menu-viewport]:data-[state=open]:fade-in-0 **:data-[slot=navigation-menu-viewport]:data-[state=closed]:fade-out-0 hidden items-stretch lg:flex"
					>
						<NavigationMenuList className="flex h-full items-stretch gap-0">
							{(navData.learn.courses.length > 0 ||
								navData.learn.freeTutorials.items.length > 0) && (
								<NavigationMenuItem className="items-stretch">
									<NavigationMenuTrigger
										className={cn(
											navTriggerReset,
											'group/nav-item relative flex h-full items-center rounded-none font-normal [&>svg]:hidden',
										)}
									>
										<NavPill>
											<svg
												xmlns="http://www.w3.org/2000/svg"
												width="24"
												height="24"
												className="mr-1 size-4"
												fill="none"
												viewBox="0 0 24 24"
											>
												<path
													stroke="currentColor"
													strokeLinejoin="round"
													strokeWidth="1.5"
													d="M14.453 12.895c-.151.627-.867 1.07-2.3 1.955-1.383.856-2.075 1.285-2.633 1.113a1.376 1.376 0 0 1-.61-.393c-.41-.45-.41-1.324-.41-3.07 0-1.746 0-2.62.41-3.07.17-.186.38-.321.61-.392.558-.173 1.25.256 2.634 1.112 1.432.886 2.148 1.329 2.3 1.955a1.7 1.7 0 0 1 0 .79Z"
												/>
												<path
													stroke="currentColor"
													strokeLinecap="round"
													strokeWidth="1.5"
													d="M20.998 11c.002.47.002.97.002 1.5 0 4.478 0 6.718-1.391 8.109C18.217 22 15.979 22 11.5 22c-4.478 0-6.718 0-8.109-1.391C2 19.217 2 16.979 2 12.5c0-4.478 0-6.718 1.391-8.109S7.021 3 11.5 3c.53 0 1.03 0 1.5.002"
												/>
												<path
													stroke="currentColor"
													strokeLinejoin="round"
													strokeWidth="1.5"
													d="m18.5 2 .258.697c.338.914.507 1.371.84 1.704.334.334.791.503 1.705.841L22 5.5l-.697.258c-.914.338-1.371.507-1.704.84-.334.334-.503.791-.841 1.705L18.5 9l-.258-.697c-.338-.914-.507-1.371-.84-1.704-.334-.334-.791-.503-1.705-.841L15 5.5l.697-.258c.914-.338 1.371-.507 1.704-.84.334-.334.503-.791.841-1.705L18.5 2Z"
													className="text-primary"
												/>
											</svg>
											Learn
											<ChevronDown
												aria-hidden="true"
												className="ml-1 size-3 opacity-80 transition duration-300 group-data-[state=open]/nav-item:rotate-180"
											/>
										</NavPill>
									</NavigationMenuTrigger>
									<NavigationMenuContent className="ease-out-quart data-[motion=from-end]:slide-in-from-right-8 data-[motion=from-start]:slide-in-from-left-8 data-[motion=to-end]:slide-out-to-right-8 data-[motion=to-start]:slide-out-to-left-8 w-full shrink-0 rounded-none p-0 duration-300">
										<div className="flex w-[300px] flex-col md:w-[480px] lg:w-[480px]">
											<ul className="divide-border flex w-full flex-col divide-y">
												{(
													[
														...navData.learn.courses,
														navData.learn.freeTutorials.featured,
														...navData.learn.freeTutorials.items,
													] as Array<
														CourseItem | FeaturedTutorial | TutorialItem
													>
												).map((item) => {
													const isCourse = navData.learn.courses.some(
														(c) => c.href === item.href,
													)
													return (
														<NavigationMenuLink key={item.href} asChild>
															<Link
																prefetch={true}
																href={item.href}
																className={cn(
																	navLinkReset,
																	'group/resource relative block',
																)}
																onClick={() => {
																	track('navigation_menu_item_click', {
																		resource: item.title,
																		type: isCourse ? 'course' : 'tutorial',
																		category: 'navigation',
																	})
																}}
															>
																<ResourceHoverFrame surfaceClassName="bg-popover">
																	<div className="flex flex-row items-center gap-4 px-3 py-3 pr-8">
																		<div className="aspect-video w-[120px] shrink-0 overflow-hidden md:w-[140px]">
																			{item.image ? (
																				<CldImage
																					src={item.image.src}
																					alt={item.image.alt}
																					width={item.image.width}
																					height={item.image.height}
																					className="block h-full w-full object-cover"
																				/>
																			) : (
																				<div
																					aria-hidden
																					className="bg-stripes h-full w-full"
																				/>
																			)}
																		</div>
																		<div className="flex flex-col gap-1">
																			<div className="flex flex-wrap items-center gap-2">
																				<div className="text-lg font-semibold leading-tight tracking-tight">
																					{'title' in item ? item.title : null}
																				</div>
																				{'badge' in item && item.badge && (
																					<span className="bg-primary text-primary-foreground inline-flex items-center rounded-full px-2 py-0.5 font-mono text-[10px] font-medium uppercase tracking-wider">
																						{item.badge}
																					</span>
																				)}
																			</div>
																			<p className="text-muted-foreground text-sm font-normal leading-snug">
																				{'description' in item
																					? item.description
																					: null}
																			</p>
																		</div>
																		<ChevronRight className="text-foreground absolute right-3 top-1/2 -translate-y-1/2" />
																	</div>
																</ResourceHoverFrame>
															</Link>
														</NavigationMenuLink>
													)
												})}
											</ul>
										</div>
									</NavigationMenuContent>
								</NavigationMenuItem>
							)}
							{(navData.live.cohorts.length > 0 ||
								navData.live.pastCohorts.length > 0 ||
								navData.live.events.length > 0 ||
								navData.live.pastEvents.length > 0) && (
								<NavigationMenuItem className="items-stretch">
									<NavigationMenuTrigger
										className={cn(
											navTriggerReset,
											'group/nav-item relative flex h-full items-center rounded-none font-normal [&>svg]:hidden',
										)}
									>
										<NavPill>
											<svg
												xmlns="http://www.w3.org/2000/svg"
												width="16"
												height="12"
												fill="none"
												viewBox="0 0 16 12"
												className="size-4.5 mr-1"
											>
												<path
													stroke="currentColor"
													// strokeWidth="1.5"
													strokeLinejoin="round"
													d="M10.428 10.834C9.616 11.5 8.41 11.5 6 11.5s-3.616 0-4.428-.666a2.932 2.932 0 0 1-.406-.406C.5 9.615.5 8.41.5 6s0-3.616.666-4.428c.122-.148.258-.284.406-.406C2.385.5 3.59.5 6 .5s3.616 0 4.428.666c.148.122.284.258.406.406.666.813.666 2.017.666 4.428 0 2.41 0 3.616-.666 4.428a2.931 2.931 0 0 1-.406.406Z"
												/>
												<path
													fill="currentColor"
													className="text-primary"
													// strokeWidth="1.5"
													d="M6.354 6.354a.5.5 0 1 1-.708-.707.5.5 0 0 1 .708.707Z"
												/>
												<path
													stroke="currentColor"
													className="text-primary"
													// strokeWidth="1.5"
													strokeLinejoin="round"
													d="M6 5.5a.5.5 0 1 0 0 1 .5.5 0 0 0 0-1Zm0 1v-1"
												/>
												<path
													stroke="currentColor"
													// strokeWidth="1.5"
													strokeLinejoin="round"
													d="M11.5 6.734V5.267l1.907-2.542a.977.977 0 0 1 1.76.586V8.69a.978.978 0 0 1-1.76.586L11.5 6.734Z"
												/>
											</svg>
											Live
											<ChevronDown
												aria-hidden="true"
												className="ml-1 size-3 opacity-80 transition duration-300 group-data-[state=open]/nav-item:rotate-180"
											/>
										</NavPill>
									</NavigationMenuTrigger>
									<NavigationMenuContent className="ease-out-quart data-[motion=from-end]:slide-in-from-right-8 data-[motion=from-start]:slide-in-from-left-8 data-[motion=to-end]:slide-out-to-right-8 data-[motion=to-start]:slide-out-to-left-8 w-full shrink-0 rounded-none p-0 duration-300">
										{(() => {
											const currentItems = [
												...navData.live.cohorts.map((c) => ({
													href: c.href,
													title: c.title,
													secondary: c.subtitle,
													image: c.image,
													type: 'cohort' as const,
												})),
												...navData.live.events.map((e) => ({
													href: e.href,
													title: e.title,
													secondary: e.date,
													image: e.image,
													type: 'event' as const,
												})),
											]
											const pastItems = [
												...navData.live.pastCohorts.map((c) => ({
													href: c.href,
													title: c.title,
													secondary: c.subtitle,
													image: c.image,
													type: 'cohort' as const,
												})),
												...navData.live.pastEvents.map((e) => ({
													href: e.href,
													title: e.title,
													secondary: e.date,
													image: e.image,
													type: 'event' as const,
												})),
											]
											type LiveItem = (typeof currentItems)[number]
											const renderRow = (item: LiveItem) => (
												<NavigationMenuLink key={item.href} asChild>
													<Link
														prefetch={true}
														href={item.href}
														className={cn(
															navLinkReset,
															'group/resource relative block',
														)}
														onClick={() => {
															track('navigation_menu_item_click', {
																resource: item.title,
																type: item.type,
																category: 'navigation',
															})
														}}
													>
														<ResourceHoverFrame surfaceClassName="bg-popover">
															<div className="flex flex-row items-center gap-4 px-3 py-3 pr-8">
																<div className="aspect-video w-[120px] shrink-0 overflow-hidden md:w-[140px]">
																	{item.image ? (
																		<CldImage
																			src={item.image.src}
																			alt={item.image.alt}
																			width={item.image.width}
																			height={item.image.height}
																			className="block h-full w-full object-cover"
																		/>
																	) : (
																		<div
																			aria-hidden
																			className="bg-stripes h-full w-full"
																		/>
																	)}
																</div>
																<div className="flex flex-col gap-1">
																	<div className="text-lg font-semibold leading-tight tracking-tight">
																		{item.title}
																	</div>
																	<p className="text-muted-foreground text-sm font-normal leading-snug">
																		{item.secondary}
																	</p>
																</div>
																<ChevronRight className="text-foreground absolute right-3 top-1/2 -translate-y-1/2" />
															</div>
														</ResourceHoverFrame>
													</Link>
												</NavigationMenuLink>
											)
											return (
												<div className="flex w-[300px] flex-col md:w-[480px] lg:w-[480px]">
													{currentItems.length === 0 && (
														<div className="text-muted-foreground mb-3 border-b px-3 py-3 text-sm">
															No live events scheduled at the moment.
														</div>
													)}
													{currentItems.length > 0 && (
														<ul className="divide-border flex w-full flex-col divide-y">
															{currentItems.map(renderRow)}
														</ul>
													)}
													{pastItems.length > 0 && (
														<>
															<div className={navSubheadingClassName}>Past</div>
															<ul className="divide-border flex w-full flex-col divide-y">
																{pastItems.map(renderRow)}
															</ul>
														</>
													)}
												</div>
											)
										})()}
									</NavigationMenuContent>
								</NavigationMenuItem>
							)}
							<NavigationMenuItem className="flex items-center justify-center">
								<NavigationMenuLink
									className={cn(
										navLinkReset,
										'group/nav-item text-foreground flex h-full flex-row items-center justify-center px-2 font-normal',
									)}
									asChild
									active={pathname === navData.browseAll.href}
								>
									<Link
										prefetch={true}
										href={navData.browseAll.href}
										onClick={() => {
											track('navigation_menu_item_click', {
												resource: navData.browseAll.label,
												type: 'browse_all',
												category: 'navigation',
											})
										}}
									>
										<NavPill>
											<svg
												xmlns="http://www.w3.org/2000/svg"
												className="size-4.5 dark:text-foreground mr-1"
												width="24"
												height="24"
												fill="none"
												viewBox="0 0 24 24"
											>
												<path
													stroke="currentColor"
													strokeLinecap="round"
													strokeWidth="1.5"
													d="M11.5 21c-4.478 0-6.718 0-8.109-1.391C2 18.217 2 15.979 2 11.5c0-4.478 0-6.718 1.391-8.109S7.021 2 11.5 2c4.478 0 6.718 0 8.109 1.391S21 7.021 21 11.5"
												/>
												<path
													stroke="currentColor"
													strokeLinejoin="round"
													strokeWidth="1.5"
													d="M2 7h19"
												/>
												<path
													stroke="currentColor"
													strokeLinecap="round"
													strokeLinejoin="round"
													strokeWidth="1.5"
													d="M10 16h1m-5 0h1"
												/>
												<path
													stroke="currentColor"
													strokeLinecap="round"
													strokeLinejoin="round"
													strokeWidth="1.5"
													d="M10 12h4m-8 0h1"
												/>
												<path
													className="text-primary"
													stroke="currentColor"
													strokeLinecap="round"
													strokeLinejoin="round"
													strokeWidth="1.5"
													d="M20.4 20.4 22 22m-.8-4.4a3.6 3.6 0 1 0-7.2 0 3.6 3.6 0 0 0 7.2 0Z"
													// opacity=".4"
												/>
											</svg>
											<span>{navData.browseAll.label}</span>
										</NavPill>
									</Link>
								</NavigationMenuLink>
							</NavigationMenuItem>
						</NavigationMenuList>
					</NavigationMenu>
					{/* {links.length > 0 && (
						<nav
							className={cn('flex items-stretch', {
								'hidden sm:flex': links.length > 3,
							})}
							aria-label={`Navigation header with ${links.length} links`}
						>
							<ul className="divide-border flex items-stretch sm:divide-x">
								{links.map((link, i) => {
									return (
										<NavLinkItem
											className={cn('text-base font-medium', {
												'hidden md:flex': i > 0,
											})}
											key={link.href || link.label}
											{...link}
										/>
									)
								})}
							</ul>
						</nav>
					)} */}
				</div>
				<nav className="flex items-stretch" aria-label={`User navigation`}>
					{/* {!ability.can('read', 'Invoice') && abilityStatus !== 'pending' && (
					<div className="flex items-center pr-5">
						<Button asChild size="sm" className="h-8">
							<Link href="/#buy">Get Access</Link>
						</Button>
					</div>
				)} */}
					<ul className="hidden items-stretch lg:flex">
						<SessionDependentNavItems
							sessionStatus={sessionStatus}
							subscriber={subscriber}
							setIsFeedbackDialogOpen={setIsFeedbackDialogOpen}
						/>
						<UserMenu />
						{/* <ThemeToggle className="hover:bg-muted px-5" /> */}
					</ul>
				</nav>
				<MobileNavigation
					isMobileMenuOpen={isMobileMenuOpen}
					setIsMobileMenuOpen={setIsMobileMenuOpen}
					subscriber={subscriber}
				/>
			</div>
		</header>
	)
}

export default Navigation

const components: { title: string; href: string; description: string }[] = [
	{
		title: 'Alert Dialog',
		href: '/docs/primitives/alert-dialog',
		description:
			'A modal dialog that interrupts the user with important content and expects a response.',
	},
	{
		title: 'Hover Card',
		href: '/docs/primitives/hover-card',
		description:
			'For sighted users to preview content available behind a link.',
	},
	{
		title: 'Progress',
		href: '/docs/primitives/progress',
		description:
			'Displays an indicator showing the completion progress of a task, typically displayed as a progress bar.',
	},
	{
		title: 'Scroll-area',
		href: '/docs/primitives/scroll-area',
		description: 'Visually or semantically separates content.',
	},
	{
		title: 'Tabs',
		href: '/docs/primitives/tabs',
		description:
			'A set of layered sections of content—known as tab panels—that are displayed one at a time.',
	},
	{
		title: 'Tooltip',
		href: '/docs/primitives/tooltip',
		description:
			'A popup that displays information related to an element when the element receives keyboard focus or the mouse hovers over it.',
	},
]
