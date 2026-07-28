'use client'

import * as React from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { createAppAbility } from '@/ability'
import { TYPE } from '@/components/landing/type'
import { api } from '@/trpc/react'
import { track } from '@/utils/analytics'
import { ChevronRightIcon } from 'lucide-react'
import { useSession } from 'next-auth/react'

import { useFeedback } from '@coursebuilder/ui/feedback-widget/feedback-context'
import { cn } from '@coursebuilder/utils/cn'

import { ThemeToggle } from './theme-toggle'
import { useNavLinks } from './use-nav-links'

/**
 * Machine-readable entry points. Every one of these resolves through
 * `markdown-route-config.mjs` (`/skills.md` rewrites to `/md/skills`), so all
 * four are live routes rather than aspirational ones.
 */
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

const focusRing =
	'rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background'

/** Column links: 14px, muted ink, one gap per row. */
const linkClass = cn(
	TYPE.meta,
	focusRing,
	'text-[color:var(--ah-fg-muted)] hover:text-foreground transition-colors',
)

/** The Agents column is data, so it is mono (rule 10). */
const monoLinkClass = cn(
	TYPE.metaMono,
	focusRing,
	'text-[color:var(--ah-fg-muted)] hover:text-foreground transition-colors',
)

const listClass = 'flex flex-col items-start gap-2.5'

const dimSiblingsOnHover =
	'[&:has(a:hover,button:hover)_a:not(:hover)]:opacity-60 [&:has(a:hover,button:hover)_button:not(:hover)]:opacity-60'

function Eyebrow({ children }: { children: React.ReactNode }) {
	return (
		<h3 className={cn(TYPE.micro, 'mb-4 text-[color:var(--ah-fg-label)]')}>
			{children}
		</h3>
	)
}

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
		<div>
			<Eyebrow>Learn</Eyebrow>
			<ul className={cn(listClass, dimSiblingsOnHover)}>
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
		</div>
	)
}

function LiveColumn() {
	const navData = useNavLinks()
	const cohorts = navData.live.cohorts
	const events = navData.live.events
	const isEmpty = cohorts.length === 0 && events.length === 0

	return (
		<div>
			<Eyebrow>Live</Eyebrow>
			{isEmpty ? (
				<div className={listClass}>
					<p className={cn(TYPE.metaProse, 'text-[color:var(--ah-fg-muted)]')}>
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
				<ul className={cn(listClass, dimSiblingsOnHover)}>
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
		</div>
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

	if (!mounted || sessionStatus === 'loading') {
		return (
			<div>
				<Eyebrow>Account</Eyebrow>
				<div className="bg-foreground/10 h-3 w-24 rounded-sm" />
			</div>
		)
	}

	const isAuthed = Boolean(sessionData?.user?.email)

	return (
		<div>
			<Eyebrow>Account</Eyebrow>
			<ul className={cn(listClass, dimSiblingsOnHover)}>
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
		</div>
	)
}

function AgentsColumn() {
	return (
		<div>
			<Eyebrow>Agents</Eyebrow>
			<ul className={cn(listClass, dimSiblingsOnHover)}>
				{agentLinks.map((link) => (
					<li key={link.href}>
						<Link
							href={link.href}
							className={monoLinkClass}
							target="_blank"
							rel="noopener"
							onClick={() => trackFooterClick(link.href, 'wrangler')}
						>
							{link.label}
						</Link>
					</li>
				))}
			</ul>
		</div>
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
		<div className="flex flex-col items-start gap-5 px-[18px] pb-8 pt-5 sm:flex-row sm:items-center lg:px-11 lg:pb-[34px] lg:pt-[22px]">
			<nav
				aria-label="Footer"
				className={cn(
					'flex flex-wrap items-center gap-x-5 gap-y-2',
					dimSiblingsOnHover,
				)}
			>
				{utilityLinks.map((link) => (
					<Link
						key={link.href}
						href={link.href}
						className={cn(
							TYPE.metaSm,
							focusRing,
							'text-[color:var(--ah-fg-subtle)] hover:text-foreground transition-colors',
						)}
						onClick={() => trackFooterClick(link.href, link.type)}
					>
						{link.label}
					</Link>
				))}
			</nav>
			{/* The prototype's bordered "System Theme" pill — the app's existing
			    ThemeToggle, restyled rather than duplicated. */}
			<ThemeToggle
				className={cn(
					TYPE.metaSm,
					'sm:ml-auto',
					'h-auto gap-2 rounded-[9px] border-input px-[13px] py-2',
					'text-[color:var(--ah-fg-subtle)] hover:text-foreground bg-transparent shadow-none dark:bg-transparent',
					'hover:bg-muted dark:hover:bg-muted sm:aspect-auto',
				)}
			/>
		</div>
	)
}

export default function Footer() {
	const pathname = usePathname()
	const isEditRoute = pathname.includes('/edit')

	if (isEditRoute) {
		return null
	}

	return (
		<footer className="border-border w-full border-t print:hidden">
			<div className="grid grid-cols-1 gap-9 border-b border-border px-[18px] pb-8 pt-10 sm:grid-cols-2 lg:grid-cols-[repeat(4,minmax(0,1fr))] lg:px-11 lg:pb-[26px] lg:pt-[52px]">
				<LearnColumn />
				<LiveColumn />
				<AccountColumn />
				<AgentsColumn />
			</div>
			<UtilityRow />
		</footer>
	)
}
