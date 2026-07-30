import { unstable_cache } from 'next/cache'
import { db } from '@/db'
import { coupon } from '@/db/schema'
import { COURSES_COMING_NEXT } from '@/lib/courses-content'
import { getSaleBannerData } from '@/lib/sale-banner'
import { getCachedMinimalWorkshop } from '@/lib/workshops-query'
import { log } from '@/server/logger'
import { and, desc, eq, gte, isNotNull } from 'drizzle-orm'

import type { Coupon } from '@coursebuilder/core/schemas'

import { getLatestCohort, getUpcomingCohort } from './upcoming-cohort-query'

/**
 * How a reader can already have answered this offer, so a CTA can check.
 *
 * Cohort and workshop waitlists are stored under different Kit field keys and
 * keyed off different things — a product NAME for one, a resource SLUG for the
 * other — so the offer carries which test applies rather than leaving every
 * call site to work it out from the `kind`.
 */
export type OfferWaitlist =
	| { kind: 'cohort'; productName: string }
	| { kind: 'workshop'; slug: string }

/**
 * The single best thing to offer a reader right now, resolved once and shared.
 *
 * There are four asks competing for the one gold slot in the nav, the card at
 * the foot of every article, and the palette's promo row: a live sale, a
 * purchasable cohort, the waitlist for a workshop that has not shipped, and
 * the waitlist for the next cohort. They used to be resolved separately or not
 * at all — the nav only ever knew about cohorts, so a sale on anything else,
 * and the crash course, were invisible outside `/courses`.
 */
export type NextOffer = {
	kind:
		| 'sale'
		| 'cohort-enroll'
		| 'cohort-waitlist'
		| 'workshop-waitlist'
	/** Resource id, so a caller can ask whether this viewer already owns it. */
	id: string
	title: string
	href: string
	label: string
	/** ISO start date when the offer carries one. */
	startsAt?: string
	/**
	 * The offer's IANA zone, travelling WITH `startsAt` — an instant is not a
	 * date until you say where. Without it the palette formatted the start in
	 * the viewer's own zone while every cohort page formatted it in the
	 * cohort's, so the two disagreed by a day either side of midnight.
	 */
	timezone?: string
	/** How to tell whether this reader already signed up. Absent when the offer
	 *  is a purchase rather than a waitlist. */
	waitlist?: OfferWaitlist
	/**
	 * Present only while a coupon is live against this offer's product.
	 * `formatted` is Kit-independent display copy — "30% off", "$50 off" —
	 * produced by the same `formatDiscount` the sale banner uses, so the number
	 * in the nav and the number at checkout cannot disagree.
	 */
	discount?: {
		formatted: string
		expires: string | null
	}
}

/**
 * The ladder, in order of what a reader can act on soonest:
 *
 * 1. **A live sale**, on whatever it is on. If we have discounted something,
 *    that is the thing to talk about, and it is the one rung that is not
 *    limited to cohorts — the coupon names a product and the sale data
 *    resolves its resource, so a standalone workshop sells here for free.
 * 2. **A purchasable cohort.** Seats you can buy today outrank interest in
 *    something that does not exist yet.
 * 3. **A workshop still in draft.** Never shipped, so it cannot be sold — but
 *    it is NEWS, and that is the whole difference between this rung and the
 *    one below it.
 * 4. **The next cohort's waitlist**, between cohorts.
 *
 * Rungs 3 and 4 are both "waitlist" in mechanism and nothing alike in meaning,
 * which is why they are separate kinds carrying separate copy rather than one
 * `waitlist` kind with a shared label:
 *
 * - A DRAFT WORKSHOP is a thing that does not exist yet. Nobody has ever been
 *   able to buy it, there is no date, and the reader has certainly not seen it
 *   before. The honest pitch is the announcement itself — "New course".
 * - A COHORT WAITLIST is a thing that already ran. It has a page, alumni, and
 *   a reader may well have watched the last one sell out. Nothing is new about
 *   it; what they want is the next date — "Join next cohort".
 *
 * Draft workshop outranks ended cohort deliberately. "Here is something that
 * did not exist last time you looked" beats "the thing you already know about
 * is still closed", and only one of those two is worth the site's one gold
 * button.
 *
 * NOT personalised, on purpose. What is on sale is the same fact for every
 * visitor, so this is cached and safe to resolve in the root layout — no
 * `cookies()`, no `headers()`, and therefore no dynamic opt-out for the pages
 * underneath it. Everything viewer-specific (already subscribed, already on
 * the waitlist, already bought) is decided by the caller and can only ever
 * REMOVE the offer.
 */
export const getNextOffer = unstable_cache(
	async (): Promise<NextOffer | null> => {
		const sale = await resolveSaleOffer()
		if (sale) return sale

		const upcoming = await getUpcomingCohort()
		if (upcoming) {
			return {
				kind: 'cohort-enroll',
				id: upcoming.id,
				title: upcoming.title,
				href: `/cohorts/${upcoming.slug}`,
				label: 'Join the cohort',
				startsAt: upcoming.startsAt,
				timezone: upcoming.timezone,
			}
		}

		const workshop = await resolveWorkshopWaitlistOffer()
		if (workshop) return workshop

		const latest = await getLatestCohort()
		if (latest) {
			return {
				kind: 'cohort-waitlist',
				id: latest.id,
				title: latest.title,
				href: `/cohorts/${latest.slug}`,
				// "Join the waitlist" names the mechanism; this names the thing you
				// get. The link goes to the cohort page either way, and between
				// cohorts the next one is what the reader is actually after.
				label: 'Join next cohort',
				startsAt: latest.startsAt,
				timezone: latest.timezone,
				...(latest.productName
					? {
							waitlist: {
								kind: 'cohort' as const,
								productName: latest.productName,
							},
						}
					: {}),
			}
		}

		return null
	},
	['next-offer-v1'],
	{ revalidate: 600, tags: ['products', 'cohorts', 'workshops'] },
)

/**
 * The discounted product as an offer, when a default coupon is live.
 *
 * `getSaleBannerData` already does the hard part: the coupon names a product,
 * and it resolves that product's public resource, path and formatted discount.
 * So this rung costs one extra read and works for any product type we ever
 * put on sale, without this file knowing what types exist.
 */
async function resolveSaleOffer(): Promise<NextOffer | null> {
	try {
		const active = await findActiveProductSaleCoupon()
		if (!active) return null

		const sale = await getSaleBannerData(active)
		if (!sale) return null

		return {
			kind: 'sale',
			id: sale.resourceId,
			title: sale.productName,
			href: sale.productPath,
			// The saving is the news, so it goes in the label rather than under it:
			// this string is the whole of the nav button and the whole of a promo
			// row, neither of which has room for a second line.
			label: `Save ${sale.discountFormatted}`,
			discount: {
				formatted: sale.discountFormatted,
				expires: sale.expires,
			},
		}
	} catch (error) {
		// A sale that cannot be resolved must fall through to the next rung, not
		// take the offer down with it. The reader still gets a cohort.
		await log
			.error('next-offer.sale.failed', {
				error: error instanceof Error ? error.message : 'Unknown error',
			})
			.catch(() => undefined)
		return null
	}
}

/**
 * The live default coupon that is restricted to a product — i.e. "the thing
 * that is on sale right now".
 *
 * Written out rather than calling `courseBuilderAdapter.getDefaultCoupon()`,
 * which cannot answer this question. That helper takes the product ids you are
 * already interested in and asks "is any of these discounted?"; called with no
 * ids its `where` narrows to `restrictedToProductId IS NULL`, so it returns
 * only site-wide coupons — and `getSaleBannerData` needs a restricted one to
 * resolve a product at all. The two compose to `null`, always. This selector
 * is the missing direction: find the sale first, then ask what it is on.
 *
 * Highest percentage first, matching the adapter's own ordering, so two
 * concurrent sales resolve to the better one rather than to whichever row the
 * database happened to return.
 *
 * Site-wide coupons (no `restrictedToProductId`) are deliberately NOT handled
 * here. They discount everything, so there is no single product for the offer
 * to point at, and the right behaviour is to fall through to the cohort rung
 * and let the cohort's own pricing widget apply the discount at checkout.
 */
async function findActiveProductSaleCoupon() {
	const row = await db.query.coupon.findFirst({
		where: and(
			eq(coupon.status, 1),
			eq(coupon.default, true),
			gte(coupon.expires, new Date()),
			isNotNull(coupon.restrictedToProductId),
		),
		orderBy: desc(coupon.percentageDiscount),
	})

	return row ? (row as unknown as Coupon) : null
}

/**
 * The unreleased workshop's waitlist.
 *
 * Keyed off `COURSES_COMING_NEXT`, which is already the single place the
 * crash course is named — the `/courses` catalog reads the same constant. That
 * keeps one editorial decision in one file instead of inventing a query for
 * "workshops with an open waitlist", which the data does not currently express.
 * The workshop still has to EXIST for the offer to render, so a stale constant
 * degrades to no offer rather than to a link into nothing.
 */
async function resolveWorkshopWaitlistOffer(): Promise<NextOffer | null> {
	const workshop = await getCachedMinimalWorkshop(COURSES_COMING_NEXT.slug)
	if (!workshop) return null

	return {
		kind: 'workshop-waitlist',
		id: workshop.id,
		title: COURSES_COMING_NEXT.title,
		href: `/workshops/${COURSES_COMING_NEXT.slug}`,
		// The NEWS, not the mechanism.
		//
		// "Join the waitlist" names a queue — something you endure to reach the
		// thing, not the thing. And "Get notified" is worse: it describes an email
		// we will send rather than a course we are making.
		//
		// "Upcoming" over "New" because the course is not out. "New course" reads
		// as something you can go and get, and the click leads to a page that
		// cannot sell it to you — a small promise broken immediately. "Upcoming"
		// says the same news and stays true until the day it ships.
		label: 'Upcoming course',
		waitlist: { kind: 'workshop', slug: COURSES_COMING_NEXT.slug },
	}
}

/**
 * `getNextOffer` for callers that must not fail with it.
 *
 * The root layout sits above every page AND above every error boundary, so an
 * exception thrown there is not a degraded nav — it is the global error page
 * instead of the site, on every route, including ones that touch no database
 * at all. The selectors underneath have no try/catch of their own and
 * `unstable_cache` re-throws on a miss, so a PlanetScale timeout with a cold
 * cache did exactly that.
 *
 * A missing offer is a nav without a CTA, which is what a visitor sees between
 * cohorts anyway. That is the right failure.
 *
 * The catch is deliberately OUT here rather than inside the cached function:
 * `unstable_cache` does not store a thrown result, so a transient blip stays
 * transient. Catching inside would cache `null` for the full 600s and keep the
 * CTA missing long after the database came back.
 */
export async function getNextOfferSafe(): Promise<NextOffer | null> {
	try {
		return await getNextOffer()
	} catch (error) {
		// The report itself is awaited but never allowed to fail the call: this
		// function exists so the root layout cannot throw, and a logger that
		// rejects (Axiom transport, a serialization edge) would otherwise take
		// down every route the same way the database timeout did.
		await log
			.error('next-offer.failed', {
				error: error instanceof Error ? error.message : 'Unknown error',
			})
			.catch(() => undefined)
		return null
	}
}
