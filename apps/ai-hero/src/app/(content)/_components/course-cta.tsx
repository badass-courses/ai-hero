import Link from 'next/link'
import { hasJoinedOfferWaitlist } from '@/lib/cta-gating'
import { hasEntitlementForResource } from '@/lib/entitlements-query'
import { getSubscriberForGating } from '@/lib/subscriber-gate'
import { getNextOffer } from '@/lib/next-offer'
import { getServerAuthSession } from '@/server/auth'
import { formatCohortDateRange } from '@/utils/format-cohort-date'
import { cn } from '@coursebuilder/utils/cn'
import { ArrowRight } from 'lucide-react'

export type CourseCtaProps = {
	/** The article this CTA renders under. Reserved for future per-post routing/analytics. */
	postId: string
	/** Editorial override: when true the CTA does not render. */
	suppress?: boolean
	className?: string
}

/**
 * High-weight, bottom-of-article CTA. Renders on every eligible article by
 * default (unless `suppress`), carrying whatever {@link getNextOffer} says is
 * the best ask right now rather than hand-authored copy — one shell, one rung
 * of the ladder in it:
 *
 * - Live sale → the discounted product, with the saving in the copy.
 * - Purchasable cohort → title + "next cohort starts {date}" + "Learn more →".
 * - Unreleased workshop → its waitlist.
 * - Between cohorts → the LATEST cohort's waitlist, linking to its own page
 *   (the /cohorts index is unused — Vojta, 2026-07-14).
 * - Already on that waitlist, or already entitled to the thing → nothing.
 *
 * The `postId` prop is untouched by this: which reader sees the card is a fact
 * about the reader, not about the article, so it is resolved the same way on
 * every page the card appears on. Which OFFER they see is not per-article
 * either — see the note on Typesense-matched offers, which this does not do.
 *
 * Generalizes `OrganicOpportunityCta`'s slug-gated hardcoded map; shares its
 * shell treatment (`border-primary/30 bg-primary/5`) as the high-weight baseline,
 * rounded shell with a pill CTA, per DESIGN.md rule 12.
 */
export async function CourseCta({
	suppress,
	className,
}: CourseCtaProps): Promise<JSX.Element | null> {
	if (suppress === true) return null

	// The SAME ladder the nav bar climbs, so the bottom of an article and the
	// top of the page cannot disagree about what is being sold today. It used to
	// resolve cohorts itself, which meant a live sale on a standalone workshop
	// was advertised in the bar and invisible here.
	const offer = await getNextOffer()
	if (!offer) return null

	// Two exits, both of them "they already did this".
	//
	// Between cohorts this card IS the waitlist ask, and it was being made of
	// people who joined that waitlist weeks ago — at the end of every article
	// they read, with a button that would only add them again. And while a
	// cohort is purchasable it asks people to enroll, including the ones who
	// already did and are reading the articles because they bought it.
	const [subscriber, auth] = await Promise.all([
		getSubscriberForGating(),
		getServerAuthSession(),
	])

	if (hasJoinedOfferWaitlist(subscriber, offer.waitlist)) return null

	// Only for signed-in readers, and only then does it cost a query — a logged
	// out visitor owns nothing and the check is skipped entirely.
	const userId = auth?.session?.user?.id
	if (userId && (await hasEntitlementForResource(userId, offer.id))) {
		return null
	}

	const isEnrolling = offer.kind === 'cohort-enroll'
	const isSale = offer.kind === 'sale'

	const eyebrow = isSale ? 'On sale now' : 'Ready to go deeper?'

	const title = offer.title

	const startsLabel = offer.startsAt
		? formatCohortDateRange(offer.startsAt, null, offer.timezone).dateString
		: null

	// One sentence per rung, and the sale's says the number. A discount the
	// reader has to click through to discover is not an offer, it is a surprise.
	const description = isSale
		? `${offer.discount?.formatted} off, for a limited time.`
		: isEnrolling
			? startsLabel
				? `Next cohort starts ${startsLabel}.`
				: 'Join the next cohort and build these habits alongside other engineers.'
			: offer.kind === 'workshop-waitlist'
				? 'Not out yet. Join the waitlist and you hear the moment it ships.'
				: 'Enrollment is closed between cohorts. Join the waitlist to hear when the next one opens.'

	const href = offer.href

	// The card's button is an ACTION, which is not always the offer's own label.
	// "Upcoming course" is right in a nav pill, where the pill is an
	// announcement; on a button under three lines of copy it names a noun and
	// asks for nothing. Every rung with a page behind it says "Learn more" —
	// including the draft workshop, whose page is where its signup lives. Only
	// the cohort waitlist keeps its own words, because "Join next cohort" IS the
	// action there.
	const label = offer.kind === 'cohort-waitlist' ? offer.label : 'Learn more'

	// The rail says what the CTA does, which is not always what its button says:
	// "Learn more" is fine under three lines of cohort copy and says nothing in a
	// list of destinations.
	const tocLabel = isSale ? `Save ${offer.discount?.formatted}` : offer.label

	return (
		<aside
			id="course-cta"
			data-toc-cta="course"
			data-toc-label={tocLabel}
			// A jump target has to clear the sticky header.
			className={cn(
				'not-prose border-primary/30 bg-primary/5 scroll-mt-(--nav-height) my-12 flex flex-col gap-4 rounded-xl border p-6 sm:p-8',
				className,
			)}
		>
			<div className="flex flex-col gap-2">
				<span className="text-primary font-mono text-[11px] font-medium uppercase tracking-wider">
					{eyebrow}
				</span>
				<h2 className="text-foreground text-balance text-2xl font-semibold leading-tight tracking-tight">
					{title}
				</h2>
				<p className="text-foreground/80 text-balance text-base leading-relaxed">
					{description}
				</p>
			</div>
			<div>
				<Link
					href={href}
					// The house primary button (the spec's `.ah-btn`, same as the hero's):
				// 46px tall, 9px radius, 15px/700, on the gold that survives BOTH
				// themes. It was a `rounded-full` pill on `bg-primary` — which is the
				// text-safe accent, so in light mode this rendered as a black button
				// rather than a gold one (DESIGN rule 7).
				className="bg-accent-fill text-accent-fill-foreground hover:bg-accent-fill-hover focus-visible:ring-ring focus-visible:ring-offset-background group relative isolate inline-flex h-[46px] items-center gap-2 overflow-hidden rounded-[9px] px-5 text-[15px] font-bold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
				>
					{label}
					<ArrowRight
						className="size-4 transition-transform group-hover:translate-x-0.5 motion-reduce:transform-none motion-reduce:transition-none"
						aria-hidden="true"
					/>
					{/* Same sweep as the newsletter submit button. Decorative only, so
					    it sits behind the label and suppresses under reduced motion. */}
					<span
						aria-hidden
						style={{ backgroundSize: '200% 100%' }}
						className="animate-shine pointer-events-none absolute inset-0 -z-10 rounded-[inherit] bg-[linear-gradient(120deg,rgba(255,255,255,0)40%,rgba(255,255,255,1)50%,rgba(255,255,255,0)60%)] opacity-10 motion-reduce:animate-none dark:opacity-20"
					/>
				</Link>
			</div>
		</aside>
	)
}
