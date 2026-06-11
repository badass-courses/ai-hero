'use client'

import * as React from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { createAppAbility } from '@/ability'
import { api } from '@/trpc/react'
import { track } from '@/utils/analytics'
import { ChevronRightIcon } from 'lucide-react'
import { useSession } from 'next-auth/react'

import { useFeedback } from '@coursebuilder/ui/feedback-widget/feedback-context'
import { cn } from '@coursebuilder/utils/cn'

import { ThemeToggle } from './theme-toggle'
import { useNavLinks } from './use-nav-links'

const agentLinks = [
	{ href: '/sitemap.md', label: 'sitemap.md' },
	{ href: '/llms.txt', label: 'llms.txt' },
	{ href: '/skills.md', label: 'skills.md' },
	{ href: '/rss.xml', label: 'rss.xml' },
]

type FooterLinkType =
	| 'skills'
	| 'skills_newsletter'
	| 'dictionary'
	| 'course'
	| 'tutorial'
	| 'cohort'
	| 'event'
	| 'browse_all'
	| 'wrangler'
	| 'newsletter'
	| 'account'
	| 'legal'

function trackFooterClick(resource: string | undefined, type: FooterLinkType) {
	track('navigation_menu_item_click', {
		resource,
		type,
		category: 'footer',
	})
}

const linkClass =
	'dark:text-muted-foreground text-foreground/80 hover:text-foreground dark:hover:text-white inline-block py-1 text-sm transition'
const headingClass =
	'text-foreground text-xs font-medium uppercase tracking-wider'
const dimSiblingsOnHover =
	'[&:has(a:hover,button:hover)_a:not(:hover)]:opacity-60 [&:has(a:hover,button:hover)_button:not(:hover)]:opacity-60'

function LearnColumn() {
	const navData = useNavLinks()
	const courses = navData.learn.courses
	const tutorials = [
		navData.learn.freeTutorials.featured,
		...navData.learn.freeTutorials.items,
	]

	if (courses.length === 0 && tutorials.length === 0) {
		return null
	}

	return (
		<>
			<h3 className={headingClass}>Learn</h3>
			<ul className={cn('flex flex-col', dimSiblingsOnHover)}>
				{courses.map((course) => (
					<li key={course.href}>
						<Link
							href={course.href}
							className={linkClass}
							onClick={() => trackFooterClick(course.title, 'course')}
						>
							{course.title}
						</Link>
					</li>
				))}
				{tutorials.map((tutorial) => (
					<li key={tutorial.href}>
						<Link
							href={tutorial.href}
							className={linkClass}
							onClick={() => trackFooterClick(tutorial.title, 'tutorial')}
						>
							{tutorial.title}
						</Link>
					</li>
				))}
			</ul>
		</>
	)
}

function LiveColumn() {
	const navData = useNavLinks()
	const cohorts = navData.live.cohorts
	const events = navData.live.events
	const isEmpty = cohorts.length === 0 && events.length === 0

	return (
		<>
			<h3 className={headingClass}>Live</h3>
			{isEmpty ? (
				<div className="flex flex-col gap-2">
					<p className="dark:text-muted-foreground text-foreground/80 text-sm">
						No live events scheduled atm.
					</p>
					<Link
						href="/newsletter"
						className={cn(linkClass, 'group inline-flex items-center gap-1')}
						onClick={() => trackFooterClick('/newsletter', 'newsletter')}
					>
						Subscribe to get notified
						<span className="inline-block transition group-hover:translate-x-0.5">
							<ChevronRightIcon className="size-3.5" />
						</span>
					</Link>
				</div>
			) : (
				<ul className={cn('flex flex-col', dimSiblingsOnHover)}>
					{cohorts.map((cohort) => (
						<li key={cohort.href}>
							<Link
								href={cohort.href}
								className={linkClass}
								onClick={() => trackFooterClick(cohort.title, 'cohort')}
							>
								{cohort.title}
							</Link>
						</li>
					))}
					{events.map((event) => (
						<li key={event.href}>
							<Link
								href={event.href}
								className={linkClass}
								onClick={() => trackFooterClick(event.title, 'event')}
							>
								{event.title}
							</Link>
						</li>
					))}
				</ul>
			)}
		</>
	)
}

function AccountColumn() {
	const [mounted, setMounted] = React.useState(false)
	const { data: sessionData, status: sessionStatus } = useSession()
	const { data: abilityRules } = api.ability.getCurrentAbilityRules.useQuery()
	const ability = createAppAbility(abilityRules || [])
	const canViewInvoice = ability.can('read', 'Invoice')
	const { setIsFeedbackDialogOpen } = useFeedback()

	React.useEffect(() => {
		setMounted(true)
	}, [])

	const heading = <h3 className={headingClass}>Account</h3>

	if (!mounted || sessionStatus === 'loading') {
		return (
			<>
				{heading}
				<div className="flex flex-col gap-2 py-1">
					<div className="bg-foreground/10 h-3 w-20 rounded" />
				</div>
			</>
		)
	}

	const isAuthed = Boolean(sessionData?.user?.email)

	return (
		<>
			{heading}
			<ul className={cn('flex flex-col gap-1', dimSiblingsOnHover)}>
				{!isAuthed && (
					<li>
						<Link
							href="/login"
							className={linkClass}
							onClick={() => trackFooterClick('/login', 'account')}
						>
							Log in / Sign up
						</Link>
					</li>
				)}
				{isAuthed && (
					<>
						<li>
							<Link
								href="/profile"
								className={linkClass}
								onClick={() => trackFooterClick('/profile', 'account')}
							>
								Profile
							</Link>
						</li>
						{canViewInvoice && (
							<li>
								<Link
									href="/invoices"
									className={linkClass}
									onClick={() => trackFooterClick('/invoices', 'account')}
								>
									Invoices
								</Link>
							</li>
						)}
						<li>
							<button
								type="button"
								className={cn(linkClass, 'cursor-pointer text-left')}
								onClick={() => {
									trackFooterClick('feedback', 'account')
									setIsFeedbackDialogOpen(true)
								}}
							>
								Feedback
							</button>
						</li>
					</>
				)}
			</ul>
		</>
	)
}

function WranglerColumn() {
	return (
		<>
			<h3 className={headingClass}>Agents</h3>
			<ul className={cn('flex flex-col gap-1', dimSiblingsOnHover)}>
				{agentLinks.map((link) => (
					<li key={link.href}>
						<Link
							href={link.href}
							className={linkClass}
							target="_blank"
							rel="noopener"
							onClick={() => trackFooterClick(link.href, 'wrangler')}
						>
							{link.label}
						</Link>
					</li>
				))}
			</ul>
		</>
	)
}

type UtilityLink = {
	href: string
	label: string
	type: FooterLinkType
}

function UtilityRow() {
	const navData = useNavLinks()

	const utilityLinks: UtilityLink[] = [
		{ href: navData.browseAll.href, label: 'Browse All', type: 'browse_all' },
		{ href: '/ai-coding-dictionary', label: 'Dictionary', type: 'dictionary' },
		{ href: '/skills', label: 'Skills', type: 'skills' },
		{
			href: '/skills/subscribe',
			label: 'Skills Newsletter',
			type: 'skills_newsletter',
		},
		{ href: '/faq', label: 'FAQ', type: 'legal' },
		{ href: '/privacy', label: 'Terms', type: 'legal' },
	]

	return (
		<div className="text-foreground/80 mx-auto flex w-full max-w-7xl flex-col items-center justify-between gap-5 text-xs sm:flex-row sm:text-sm">
			<nav
				aria-label="Footer"
				className={cn(
					'flex flex-wrap items-center gap-x-3 gap-y-1.5',
					dimSiblingsOnHover,
				)}
			>
				{utilityLinks.map((link, index) => (
					<React.Fragment key={link.href}>
						{index > 0 ? (
							<span
								aria-hidden
								className="text-muted-foreground/40 select-none"
							>
								·
							</span>
						) : null}
						<Link
							href={link.href}
							className="hover:text-foreground transition"
							onClick={() => trackFooterClick(link.href, link.type)}
						>
							{link.label}
						</Link>
					</React.Fragment>
				))}
			</nav>
			<ThemeToggle className="hover:bg-card mt-5 sm:mt-0" />
			{/* <div className="flex items-center justify-between gap-4 border-t">
				<span className="text-foreground/80 dark:text-muted-foreground">
					© AIHero.dev
				</span>
			</div> */}
		</div>
	)
}

const columnClass =
	'flex flex-col gap-6 lg:row-span-2 lg:grid lg:grid-rows-subgrid lg:gap-5'

export default function Footer() {
	const pathname = usePathname()
	const isEditRoute = pathname.includes('/edit')

	if (isEditRoute) {
		return null
	}

	return (
		<footer className="border-border w-full border-t print:hidden">
			<div className="mx-auto w-full max-w-7xl px-10 pb-12 pt-16 lg:px-0 lg:pb-0 lg:pt-0">
				<div className="divide-border grid grid-cols-1 gap-10 sm:grid-cols-2 lg:grid-cols-[3fr_3fr_2fr_2fr] lg:grid-rows-[auto_1fr] lg:gap-x-0 lg:gap-y-6 lg:divide-x">
					<div className={cn(columnClass, 'lg:pb-12 lg:pl-8 lg:pr-8 lg:pt-10')}>
						<LearnColumn />
					</div>
					<div className={cn(columnClass, 'lg:px-8 lg:pb-12 lg:pt-10')}>
						<LiveColumn />
					</div>
					<div className={cn(columnClass, 'lg:px-8 lg:pb-12 lg:pt-10')}>
						<AccountColumn />
					</div>
					<div className={cn(columnClass, 'lg:pb-12 lg:pl-8 lg:pt-10')}>
						<WranglerColumn />
					</div>
				</div>
			</div>
			<div className="border-border w-full border-t px-5 py-4 lg:px-8">
				<UtilityRow />
			</div>
		</footer>
	)
}
