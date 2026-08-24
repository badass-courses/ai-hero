import * as React from 'react'
import Image from 'next/image'
import Link from 'next/link'
import { WaitlistForm } from '@/components/cohort-waitlist-form'
import { formatStartsAt } from '@/components/landing/format'
import { BADGE_NEUTRAL, BADGE_OUTLINE, TYPE } from '@/components/landing/type'
import { DiscountCountdown } from '@/components/pricing/discount-countdown'
import { getCachedCohort } from '@/lib/cohorts-query'
import {
	FLAGSHIP_ENROLLING,
	FLAGSHIP_HERO,
	FLAGSHIP_SALE,
	FLAGSHIP_WAITLIST,
} from '@/lib/courses-content'
import type { CoursesHeroState } from '@/lib/courses-hero-state'
import { isOnCohortWaitlist } from '@/lib/cta-gating'
import { getSubscriberForGating } from '@/lib/subscriber-gate'
import type { UpcomingCohortSummary } from '@/lib/upcoming-cohort-query'
import { getResourcePath } from '@/utils/resource-paths'
import { ArrowRight } from 'lucide-react'
import { Markdown as ReactMarkdown } from '@/components/markdown'

import { cn } from '@coursebuilder/utils/cn'

/**
 * The flagship cohort as a hero, rebuilt from Amy's review (2026-07-30) and
 * deliberately shaped like the `/skills` hero.
 *
 * ## One component, two pages
 *
 * This is the `/courses` hero AND the homepage's cohort section. They used to be
 * two components making the same offer in two shapes — different badges,
 * different facts, a hardcoded description on one and the cohort's own on the
 * other — so a reader who saw both could reasonably wonder whether they were
 * looking at one product or two. There is one cohort, so there is one block.
 *
 * The only thing that varies is the heading level: on `/courses` the cohort's
 * name is the page's `h1`, on the homepage it is one section's `h2`. Everything
 * a reader can see or act on is identical, by construction rather than by
 * anyone remembering to mirror an edit.
 *
 * ## What changed and why
 *
 * The hero used to be `minmax(0,1fr) 400px` with the ask in the right cell.
 * Amy's diagnosis: the page fails the squint test — the most clickable-looking
 * things are the preview images at the bottom, and the ask is exiled to a grey
 * box on the right, where it *"will get ignored or missed."* So:
 *
 * 1. **The ask lives in the body, and it is the form.** Not a button to a page
 *    with a form on it: anywhere a reader can be put on a list, the fields go
 *    in front of them. Same treatment as the `/skills` hero — a hairline, a
 *    heading, a sentence, the fields, a note.
 * 2. **The rail holds the cohort image.** Two rules came out of the `/skills`
 *    hero: the primary CTA never lives in a rail, and a rail must hold
 *    something a reader acts on rather than a second ask. The cohort's artwork
 *    is the product's face and links to the cohort page, so the rail has a job
 *    that does not compete with the form.
 * 3. **The cohort's name is the headline.** It used to appear only as an
 *    underlined link inside the pitch paragraph, so a reader could finish the
 *    page not knowing what the thing is called. The slogan ("Stop babysitting
 *    your agent") follows as the subhead — it sells, but it does not name.
 * 4. **Unified, not dramatic.** Amy floated "the black styling or something
 *    else dramatic". The halves are merged and the CTA made prominent, but the
 *    hero stays on the page's own surface — no dark hero, and no rule between
 *    the columns.
 * 5. **The status badge gets its own treatment.** It used to wear the same gold
 *    as the newsletter CTA in the nav, which de-emphasized both. The gold now
 *    belongs to the one action.
 *
 * ## The four states
 *
 * All resolved on the server, never a client toggle. Rendering "join the
 * waitlist" while seats are on sale is the failure mode worth the branches.
 *
 * - **Waitlist** (between cohorts) — the Kit form, inline.
 * - **Purchasable** — a button to the cohort page, which is where buying
 *   happens. The only state where a link beats a form.
 * - **On sale** — the discount and its deadline, and no price: PPP makes a
 *   displayed number situation-dependent. The sale is guarded to this cohort's
 *   resource id upstream (`courses-hero-state.ts`).
 * - **Bought + running** — handled by the page, not here: it is not a sales
 *   state, so it is a strip above the hero rather than the hero's CTA.
 */
export async function CohortHero({
	flagship,
	isPurchasable,
	alumniLabel,
	sale,
	headingLevel = 'h1',
	headingId = 'cohort-hero-heading',
}: {
	flagship: UpcomingCohortSummary | null
	isPurchasable: boolean
	/** e.g. "8,500+" — null drops the stat rather than printing a zero. */
	alumniLabel: string | null
	/** A live discount on THIS cohort. Never carries a price. */
	sale: CoursesHeroState['sale']
	/**
	 * `h1` where the cohort is what the page is about (`/courses`), `h2` where it
	 * is one section of a longer page (the homepage). Only the tag changes: the
	 * type scale is `TYPE.title` either way, because the block is the same size
	 * on both pages and a heading level is an outline fact, not a visual one.
	 */
	headingLevel?: 'h1' | 'h2'
	headingId?: string
}) {
	const Heading = headingLevel
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
	const title = flagship?.title ?? FLAGSHIP_HERO.fallbackTitle
	const image = flagship?.image ?? cohort?.fields?.image ?? null
	// `cohort.fields.description` FIRST: that is the exact field
	// `cohorts/[slug]/page.tsx` renders under its title, and the point is that
	// the two pages say the same sentence. The summary's copy is the fallback
	// for the branch where the full cohort is not fetched.
	const description = cohort?.fields?.description ?? flagship?.description
	const href = flagship
		? getResourcePath('cohort', flagship.slug, 'view')
		: `#${FLAGSHIP_WAITLIST.anchorId}`

	// The offer is only "open" when there is somewhere to buy it. Everything
	// else on this page reads off this one boolean.
	const isOpen = isPurchasable && Boolean(flagship)

	// Already on this cohort's waitlist. The ask would otherwise be a request to
	// do something they did, on the page they land on when they come back to
	// check. The hero keeps its shape and drops the ask.
	const subscriber = !isOpen ? await getSubscriberForGating() : null
	const alreadyWaiting = isOnCohortWaitlist(subscriber, flagship?.productName)

	return (
		<section
			id={FLAGSHIP_WAITLIST.anchorId}
			aria-labelledby={headingId}
			// `container-type: inline-size`, the same rule the /skills hero uses:
			// the split is conditional on fit rather than on a viewport guess.
			className="border-border @container scroll-mt-24 border-b"
		>
			{/* `py-12 md:py-[52px]`, the spec's section value (DESIGN rule 3). It
			    was `py-16 md:py-20` — 64/80px, a row and a half over the scale — from
			    when the hero was two padded cells either side of a hairline and each
			    needed to hold its own height. It is one block now. */}
			<div className="@[1000px]:grid-cols-[minmax(32rem,1fr)_minmax(0,0.72fr)] @[1000px]:gap-x-12 grid grid-cols-1 items-start gap-y-10 px-[18px] py-12 sm:px-11 md:py-[52px]">
				<div className="min-w-0">
					{/* The site's one surviving floating mark, and it is on this route
					    by design: the headline is the cohort's NAME, so what kind of
					    thing it is has nowhere else to go. The status and sale badges
					    moved DOWN to the ask, where the state they describe is
					    actionable — a badge never sits above a heading. */}
					<p className={TYPE.eyebrow}>{FLAGSHIP_HERO.eyebrow}</p>

					{/* The name first. Non-negotiable per Amy, and 100% agreed: a reader
					    must be able to say what this page is selling without clicking. */}
					<Heading
						id={headingId}
						className={cn(TYPE.title, 'max-w-[20ch] text-balance')}
					>
						{title}
					</Heading>
					{/* The cohort's OWN description, the same field and the same
					    treatment the cohort page gives it (`cohorts/[slug]/page.tsx` —
					    markdown flattened to inline, set in `text-primary` under the
					    title). Two pages describing one product in two different
					    sentences is how a reader ends up unsure they are the same thing,
					    and this one was hardcoded.

					    `FLAGSHIP_HERO.subhead` is the fallback for when no cohort
					    resolves at all, which is also when the headline falls back. */}
					<p
						className={cn(
							TYPE.statement,
							'text-primary mt-5 max-w-[34ch] text-balance',
						)}
					>
						{description ? (
							<ReactMarkdown
								components={{ p: ({ children }) => <>{children}</> }}
							>
								{description}
							</ReactMarkdown>
						) : (
							FLAGSHIP_HERO.subhead
						)}
					</p>

					{/* No pitch paragraph. It existed to carry the cohort's name as an
					    inline link inside a sentence — the exact invisibility Amy flagged
					    — and now that the name is the `h1` and the cohort's own
					    description sits under it, this was a third block of prose making
					    the argument a second time before the reader reached the ask. */}
					{alreadyWaiting ? null : (
						<Ask
							isOpen={isOpen}
							href={href}
							sale={sale}
							productName={flagship?.productName ?? title}
							knownIdentity={Boolean(subscriber?.email_address)}
							surface={
								headingLevel === 'h1' ? 'courses-cohort' : 'homepage-cohort'
							}
						/>
					)}
				</div>

				{/* The rail. Not a second ask — the product's face, the route to the
				    page that sells it, and the facts a buyer checks.

				    The facts moved here from under the pitch. In the left column they
				    sat between the description and the signup, which made them a toll
				    gate on the way to the one thing this page wants; in the rail they
				    are visible immediately, beside the pitch rather than after it. */}
				<div className="flex flex-col gap-8">
					{image ? (
						<Link
							href={href}
							aria-label={`${title}: ${FLAGSHIP_HERO.imageLinkLabel.toLowerCase()}`}
							className="focus-visible:ring-ring group block rounded-[10px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
						>
							{/* Native 16:9, not a cropped fill: this artwork is a designed
							    title card, and cropping it to fill a tall cell slices the
							    type. Same treatment as the homepage cohort block. */}
							<span className="border-border relative block aspect-video w-full overflow-hidden rounded-[10px] border">
								<Image
									src={image}
									alt=""
									fill
									sizes="(min-width: 1000px) 40vw, 100vw"
									className="object-cover transition-transform duration-500 ease-out group-hover:scale-[1.02] motion-reduce:transform-none motion-reduce:transition-none"
								/>
							</span>
							<span
								aria-hidden
								className={cn(
									TYPE.meta,
									'text-muted-foreground group-hover:text-foreground mt-3.5 inline-flex items-center gap-1.5 transition-colors',
								)}
							>
								{FLAGSHIP_HERO.imageLinkLabel}
								<ArrowRight className="ease-out-quart size-3.5 shrink-0 transition-transform duration-300 group-hover:translate-x-1 motion-reduce:transform-none motion-reduce:transition-none" />
							</span>
						</Link>
					) : null}

					<Facts
						alumniLabel={alumniLabel}
						isOpen={isOpen}
						startsAt={startsAt}
						startsInFuture={startsInFuture}
						timezone={timezone}
					/>
				</div>
			</div>
		</section>
	)
}

/**
 * The ask, in the body of the hero.
 *
 * Shaped like the `/skills` course CTA on purpose — a hairline, a heading, a
 * sentence, then the control. A rule rather than a box: a de-emphasized
 * container is exactly what Amy said gets ignored, and the two heros making the
 * same ask in two different shapes is how a reader starts wondering whether
 * they are two different lists.
 */
function Ask({
	isOpen,
	href,
	sale,
	productName,
	surface,
	knownIdentity,
}: {
	isOpen: boolean
	href: string
	sale: CoursesHeroState['sale']
	productName: string
	surface: 'homepage-cohort' | 'courses-cohort'
	knownIdentity: boolean
}) {
	return (
		// No rule above it. A hairline is this design's section divider, so one
		// between the pitch and the ask read as the hero ending and something else
		// starting — which is the opposite of "the ask lives in the body". Space
		// does the separating.
		<div className="mt-10 max-w-[560px]">
			<div className="mb-3 flex flex-wrap items-center gap-2">
				{/* Neutral, not gold. Amy: the status badge wore the same yellow as
				    the newsletter CTA in the nav, "so de-emphasizes it". The gold in
				    this viewport belongs to the one thing you click. */}
				<span className={cn(TYPE.badge, BADGE_NEUTRAL, 'inline-flex w-fit')}>
					{isOpen ? FLAGSHIP_ENROLLING.badge : FLAGSHIP_WAITLIST.badge}
				</span>
				{sale ? (
					<span
						className={cn(
							TYPE.badge,
							BADGE_OUTLINE,
							'inline-flex w-fit border-[color:var(--ah-accent-line)] text-primary',
						)}
					>
						{FLAGSHIP_SALE.label}
					</span>
				) : null}
			</div>
			<h2 className={cn(TYPE.subhead, 'mb-2')}>
				{isOpen ? FLAGSHIP_ENROLLING.heading : FLAGSHIP_WAITLIST.heading}
			</h2>
			<p className={cn(TYPE.metaProse, 'text-[color:var(--ah-fg-muted)]')}>
				{isOpen
					? FLAGSHIP_ENROLLING.description
					: FLAGSHIP_WAITLIST.description}
			</p>

			{sale ? (
				<p className={cn(TYPE.meta, 'text-primary mt-3.5')}>
					{FLAGSHIP_SALE.claim(sale.formatted)}
					{sale.expires ? (
						<span className={cn(TYPE.metaMark, 'ml-2')}>
							{FLAGSHIP_SALE.deadlineLabel}{' '}
							<DiscountCountdown date={sale.expires} />
						</span>
					) : null}
				</p>
			) : null}

			<div className="mt-4">
				{isOpen ? (
					// The one state where a link beats a form: there is a page to buy
					// on, and a waitlist form would be a detour around the sale.
					<Link
						href={href}
						className={cn(
							TYPE.meta,
							'bg-accent-fill text-accent-fill-foreground hover:bg-accent-fill-hover focus-visible:ring-ring group inline-flex h-[46px] items-center justify-center gap-2 rounded-[9px] px-6 font-bold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2',
						)}
					>
						{FLAGSHIP_ENROLLING.ctaLabel}
						<ArrowRight
							aria-hidden
							className="ease-out-quart size-4 shrink-0 transition-transform duration-300 group-hover:translate-x-1 motion-reduce:transform-none motion-reduce:transition-none"
						/>
					</Link>
				) : (
					<>
						<WaitlistForm
							actionLabel={FLAGSHIP_WAITLIST.actionLabel}
							productName={productName}
							surface={surface}
							knownIdentity={knownIdentity}
						/>
						{/* Sans, not mono: this is a sentence, not data. */}
						<p
							className={cn(
								TYPE.metaSm,
								'mt-2.5 text-[color:var(--ah-fg-subtle)]',
							)}
						>
							{FLAGSHIP_WAITLIST.note}
						</p>
					</>
				)}
			</div>
		</div>
	)
}

/**
 * The practical facts, on a hairline rather than in boxes: the things a buyer
 * checks before reading anything else.
 *
 * A grid, not a flex row: flex-wrap turns three facts into a ragged
 * two-plus-one the moment the copy grows, and these read as columns. The stat
 * keeps its natural width and the sentences split what is left, so a long
 * format line wraps inside its own column instead of shoving the next one down.
 *
 * "Next dates" drops out entirely between cohorts. It used to read "Announced
 * to the list first", which — with the form standing right above it — is the
 * form's own promise said twice.
 */
function Facts({
	alumniLabel,
	isOpen,
	startsAt,
	startsInFuture,
	timezone,
}: {
	alumniLabel: string | null
	isOpen: boolean
	startsAt: Date | null
	startsInFuture: boolean
	timezone: string
}) {
	return (
		// Flex, not the 3-across grid it used to be. In the rail there is not
		// room for three columns of fact, and a grid with a fixed column count
		// breaks anyway when a fact is absent — which two of these are. Wrapping
		// with a gap lets a missing fact close its own gap up.
		// Same reasoning as the ask: no rule. In the rail the facts already sit
		// under the image with a gap between them, and a hairline there fenced
		// them off from the block they describe.
		<dl className="flex flex-wrap gap-x-10 gap-y-5">
			{alumniLabel ? (
				<Fact label={FLAGSHIP_HERO.trainedLabel}>
					<span className={TYPE.stat}>{alumniLabel}</span>
				</Fact>
			) : null}
			<Fact label={FLAGSHIP_HERO.formatLabel}>
				<span className={TYPE.bodyTight}>{FLAGSHIP_HERO.formatValue}</span>
			</Fact>
			{isOpen ? (
				<Fact label={FLAGSHIP_HERO.datesLabel}>
					<span className={TYPE.bodyTight}>
						{startsInFuture && startsAt
							? formatStartsAt(startsAt, timezone)
							: FLAGSHIP_HERO.datesOpenValue}
					</span>
				</Fact>
			) : null}
		</dl>
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
		// `flex-col-reverse`: a `<dl>` wants `<dt>` before `<dd>` in the DOM, and
		// `TYPE.statLabel` is a caption that always sits BELOW the value it names.
		// The old order put a mono caps label above every value, which is three
		// more floating marks in the one viewport the eyebrow budget is about.
		<div className="flex flex-col-reverse">
			<dt className={TYPE.statLabel}>{label}</dt>
			<dd>{children}</dd>
		</div>
	)
}
