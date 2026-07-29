import * as React from 'react'
import Link from 'next/link'
import { formatStartsAt } from '@/components/landing/format'
import { TYPE } from '@/components/landing/type'
import { getCachedCohort } from '@/lib/cohorts-query'
import {
	FLAGSHIP_ENROLLING,
	FLAGSHIP_HERO,
	FLAGSHIP_WAITLIST,
} from '@/lib/courses-content'
import type { UpcomingCohortSummary } from '@/lib/upcoming-cohort-query'
import { getResourcePath } from '@/utils/resource-paths'
import { ArrowRight } from 'lucide-react'

import { cn } from '@coursebuilder/utils/cn'

import { WaitlistForm } from './waitlist-form'

/**
 * The flagship cohort AS the page hero (redesign direction `1a`).
 *
 * The page used to open on a masthead — "Learn with Matt", the site's own
 * name for itself — and put the offer in the block below it. Two headlines,
 * two asks, and the reader had to get past a table of contents for a page
 * that sells one thing. So the masthead is gone and this is the first thing
 * on the page: pitch left, the ask right, one hairline between them.
 *
 * The handoff pins the grid at `minmax(0,1fr) 400px` rather than one of the
 * editorial ratios in DESIGN rule 4, because the right cell is a form rail
 * and a form does not get wider just because the window did. It splits at
 * `lg` rather than `md`: a 400px rail against a 368px pitch is not a
 * hierarchy, it is two columns arguing.
 *
 * Both states of the offer live here, resolved on the server (never a client
 * toggle): a purchasable cohort gets dates and a button to the cohort page, a
 * closed one gets the waitlist form. Rendering "join the waitlist" while
 * seats are on sale is the failure mode worth the branch.
 */
export async function FlagshipHero({
	flagship,
	isPurchasable,
	alumniLabel,
}: {
	flagship: UpcomingCohortSummary | null
	isPurchasable: boolean
	/** e.g. "8,500+" — null drops the stat rather than printing a zero. */
	alumniLabel: string | null
}) {
	const cohort = flagship ? await getCachedCohort(flagship.slug) : null
	const startsAt = flagship?.startsAt ? new Date(flagship.startsAt) : null
	// Dates only render when they are in the future. A past "Starts 3 June"
	// reads as a live offer you already missed.
	//
	// The purity rule is about components that re-render on the client, where a
	// clock read gives unstable results. This is an async server component: it
	// runs once per request and never re-renders, so "now" is exactly the
	// semantics wanted.
	// eslint-disable-next-line react-hooks/purity -- async server component, evaluated once per request
	const startsInFuture = startsAt !== null && startsAt.getTime() > Date.now()
	const timezone = cohort?.fields?.timezone ?? 'America/Los_Angeles'
	const title = flagship?.title ?? 'AI Coding for Real Engineers'
	const href = flagship
		? getResourcePath('cohort', flagship.slug, 'view')
		: `#${FLAGSHIP_WAITLIST.anchorId}`

	// The offer is only "open" when there is somewhere to buy it. Everything
	// else on this page reads off this one boolean.
	const isOpen = isPurchasable && Boolean(flagship)

	return (
		<section
			id={FLAGSHIP_WAITLIST.anchorId}
			aria-labelledby="flagship-heading"
			className="border-border bg-border grid scroll-mt-24 grid-cols-1 gap-px border-b lg:grid-cols-[minmax(0,1fr)_400px]"
		>
			<div className="bg-background flex flex-col justify-center px-[18px] py-16 sm:px-11 md:py-20">
				<div className="flex flex-wrap items-center gap-x-3 gap-y-2">
					<span
						className={cn(
							TYPE.micro,
							// Optically centred, not geometrically. `TYPE.micro` is all-caps
							// with `leading-[1.4]`, so the line box is 13.3px around a 9.5px
							// font and the glyphs — having no descenders — hang in the top
							// of it. Even padding centres the BOX and leaves the ink sitting
							// ~1.25px high, which is visible on a chip this small. The 12px
							// total is unchanged, just biased down.
							'bg-accent-fill text-accent-fill-foreground inline-flex items-center rounded-[4px] px-2 pb-[5px] pt-[7px]',
						)}
					>
						{isOpen ? FLAGSHIP_ENROLLING.badge : FLAGSHIP_WAITLIST.badge}
					</span>
					<span className={cn(TYPE.micro, 'text-[color:var(--ah-fg-label)]')}>
						{FLAGSHIP_HERO.eyebrow}
					</span>
				</div>

				<h1
					id="flagship-heading"
					className={cn(TYPE.title, 'mt-6 text-balance')}
				>
					{FLAGSHIP_HERO.headline}
				</h1>

				<p
					className={cn(
						TYPE.lead,
						'mt-6 max-w-[53ch] text-[color:var(--ah-fg-muted)]',
					)}
				>
					{FLAGSHIP_HERO.pitchLead}{' '}
					{/* The cohort's name is the one place in this paragraph a reader
					    wants to click, and it was inert — the only route to the cohort
					    page was the right-hand button, which is a waitlist form while
					    enrollment is closed. Linked only when a cohort actually exists;
					    otherwise `href` is this section's own anchor and the name would
					    link to itself. Underline rather than gold: the badge and the
					    enroll button already spend this view's accent. */}
					{flagship ? (
						<Link
							href={href}
							className="text-foreground hover:decoration-foreground focus-visible:ring-ring rounded-sm font-medium underline decoration-[color:var(--ah-line-strong)] underline-offset-4 transition-colors focus-visible:outline-none focus-visible:ring-2"
						>
							{title}
						</Link>
					) : (
						<strong className="text-foreground font-medium">{title}</strong>
					)}{' '}
					{FLAGSHIP_HERO.pitchTail}
				</p>

				{/* The practical facts, on a hairline rather than in boxes: three
				    things a buyer checks before reading anything else.

				    A grid, not a flex row: flex-wrap turns three facts into a
				    ragged two-plus-one the moment the copy grows, and these read
				    as columns. The stat keeps its natural width and the two
				    sentences split what is left, so a long format line wraps
				    inside its own column instead of shoving the next one down. */}
				<dl
					className={cn(
						'border-border mt-9 grid grid-cols-1 gap-6 border-t pt-7 sm:gap-x-10',
						alumniLabel
							? 'sm:grid-cols-[auto_minmax(0,1fr)_minmax(0,1fr)]'
							: 'sm:grid-cols-[repeat(2,minmax(0,1fr))]',
					)}
				>
					{alumniLabel ? (
						<Fact label={FLAGSHIP_HERO.trainedLabel}>
							<span className={TYPE.stat}>{alumniLabel}</span>
						</Fact>
					) : null}
					<Fact label={FLAGSHIP_HERO.formatLabel}>
						<span className={TYPE.bodyTight}>{FLAGSHIP_HERO.formatValue}</span>
					</Fact>
					<Fact label={FLAGSHIP_HERO.datesLabel}>
						<span className={cn(TYPE.bodyTight, !isOpen && 'text-primary')}>
							{isOpen
								? startsInFuture && startsAt
									? formatStartsAt(startsAt, timezone)
									: FLAGSHIP_HERO.datesOpenValue
								: FLAGSHIP_HERO.datesWaitlistValue}
						</span>
					</Fact>
				</dl>
			</div>

			{/* The ask, on the raised surface the spec reserves for it. */}
			<div className="bg-muted flex flex-col justify-center px-8 py-12 sm:px-10 lg:py-16">
				<h2 className={TYPE.subhead}>
					{isOpen ? FLAGSHIP_ENROLLING.heading : FLAGSHIP_WAITLIST.heading}
				</h2>
				<p
					className={cn(
						TYPE.metaProse,
						'mt-2 text-[color:var(--ah-fg-muted)]',
					)}
				>
					{isOpen
						? FLAGSHIP_ENROLLING.description
						: FLAGSHIP_WAITLIST.description}
				</p>

				<div className="mt-6">
					{isOpen ? (
						<Link
							href={href}
							className={cn(
								TYPE.meta,
								'bg-accent-fill text-accent-fill-foreground hover:bg-accent-fill-hover focus-visible:ring-ring group inline-flex h-[46px] w-full items-center justify-center gap-2 rounded-[9px] font-bold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2',
							)}
						>
							{FLAGSHIP_ENROLLING.ctaLabel}
							<ArrowRight
								aria-hidden
								className="ease-out-quart size-4 shrink-0 transition-transform duration-300 group-hover:translate-x-1 motion-reduce:transform-none motion-reduce:transition-none"
							/>
						</Link>
					) : (
						<WaitlistForm actionLabel={FLAGSHIP_WAITLIST.actionLabel} />
					)}
				</div>

				{isOpen ? null : (
					<p
						className={cn(
							TYPE.command,
							'mt-3 font-normal text-[color:var(--ah-fg-faint)]',
						)}
					>
						{FLAGSHIP_WAITLIST.note}
					</p>
				)}
			</div>
		</section>
	)
}

function Fact({
	label,
	children,
}: {
	label: string
	children: React.ReactNode
}) {
	return (
		<div className="flex flex-col gap-2">
			<dt className={cn(TYPE.micro, 'text-[color:var(--ah-fg-label)]')}>
				{label}
			</dt>
			<dd>{children}</dd>
		</div>
	)
}
