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

/**
 * Column links: 14px, muted ink. The row rhythm is `py-[5px]` on the link
 * rather than a gap on the list, so neighbouring hit areas touch — see
 * `linkListClass`.
 */
const linkClass = cn(
	TYPE.meta,
	focusRing,
	'inline-block py-[5px] text-[color:var(--ah-fg-muted)] hover:text-foreground transition-colors',
)

/** The Agents column is data, so it is mono (rule 10). */
const monoLinkClass = cn(
	TYPE.metaMono,
	focusRing,
	'inline-block py-[5px] text-[color:var(--ah-fg-muted)] hover:text-foreground transition-colors',
)

const listClass = 'flex flex-col items-start gap-2.5'

/**
 * Link lists carry no gap. `dimSiblingsOnHover` keys off `:has(a:hover)`, so a
 * dead gap between rows unhovers everything mid-travel and the whole column
 * flashes back to full opacity between one link and the next. The 10px rhythm
 * comes from `py-[5px]` on the links instead, which makes the hit areas tile:
 * the pointer is always over some link, and the spotlight never drops. The
 * negative margin gives back the 5px added above the first row and below the
 * last so the column's outer spacing is unchanged.
 */
const linkListClass = '-my-[5px] flex flex-col items-start'

const dimSiblingsOnHover =
	'[&:has(a:hover,button:hover)_a:not(:hover)]:opacity-60 [&:has(a:hover,button:hover)_button:not(:hover)]:opacity-60'

function Eyebrow({ children }: { children: React.ReactNode }) {
	return (
		<h3 className={cn(TYPE.groupLabel, 'mb-4')}>
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
			<ul className={cn(linkListClass, dimSiblingsOnHover)}>
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

/**
 * Every cohort that has run, current one first.
 *
 * Was "Live", listing only the current cohort and any scheduled event. That
 * gave someone who bought an earlier cohort no route back to it from any page
 * — the footer is the one piece of navigation on every screen, and it was
 * showing them a single cohort that is probably not theirs. `pastCohorts` was
 * already in `useNavLinks`; nothing rendered it.
 *
 * Listing all of them also makes the current/past split in that data harmless
 * here. It is hand-maintained, so a finished cohort sits in `cohorts` until
 * someone moves it (June's is there now); a footer column of titles does not
 * claim either way, so the drift stops mattering.
 */
function CohortsColumn() {
	const navData = useNavLinks()
	const cohorts = [...navData.live.cohorts, ...navData.live.pastCohorts]

	return (
		<div>
			<Eyebrow>Cohorts</Eyebrow>
			{cohorts.length === 0 ? (
				<div className={listClass}>
					<p className={cn(TYPE.metaProse, 'text-[color:var(--ah-fg-muted)]')}>
						No cohorts scheduled atm.
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
				<ul className={cn(linkListClass, dimSiblingsOnHover)}>
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
			<ul className={cn(linkListClass, dimSiblingsOnHover)}>
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
								href="/profile#my-courses"
								className={linkClass}
								onClick={() =>
									trackFooterClick('/profile#my-courses', 'account')
								}
							>
								My Courses
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
			<ul className={cn(linkListClass, dimSiblingsOnHover)}>
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

	// Skills and the free course lead, ahead of the Dictionary: they are the
	// two things this row is actually for, and the free course is the site's
	// primary ask — the nav's gold CTA points at the same page. "Skills
	// Newsletter" undersold it as a mailing list rather than the course you
	// get for signing up, which is how every other surface names it. The
	// analytics `type` stays `skills_newsletter` so the label change does not
	// break the series.
	const utilityLinks: UtilityLink[] = [
		{ href: navData.browseAll.href, label: 'Browse All', type: 'browse_all' },
		{ href: '/skills', label: 'Skills', type: 'skills' },
		{
			href: '/skills/subscribe',
			label: 'Free course',
			type: 'skills_newsletter',
		},
		{ href: '/ai-coding-dictionary', label: 'Dictionary', type: 'dictionary' },
		{ href: '/faq', label: 'FAQ', type: 'legal' },
		{ href: '/privacy', label: 'Terms', type: 'legal' },
	]

	return (
		<div className="flex flex-col items-start gap-5 px-[18px] pb-8 pt-5 sm:flex-row sm:items-center lg:px-11 lg:pb-[34px] lg:pt-[22px]">
			<nav
				aria-label="Footer"
				className={cn(
					// Same reasoning as `linkListClass`: the 20px/8px rhythm lives in
					// the links' padding so the row's hit areas touch and the
					// spotlight survives the trip between them.
					'-mx-2.5 -my-1 flex flex-wrap items-center',
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
							// The 20px/8px rhythm this row used to get from `gap-x-5
							// gap-y-2`, moved into the links so their hit areas tile and
							// the hover spotlight survives the trip between them. The
							// container cancels the outer edge with `-mx-2.5 -my-1`.
							'inline-block px-2.5 py-1 text-[color:var(--ah-fg-subtle)] hover:text-foreground transition-colors',
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
				<CohortsColumn />
				<AccountColumn />
				<AgentsColumn />
			</div>
			<UtilityRow />
		</footer>
	)
}
