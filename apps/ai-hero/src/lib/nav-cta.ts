import { unstable_cache } from 'next/cache'
import { log } from '@/server/logger'

import { getLatestCohort, getUpcomingCohort } from './upcoming-cohort-query'

/**
 * The cohort half of a call to action, resolved once and shared.
 *
 * `enroll` when a cohort is actually purchasable, `waitlist` between cohorts —
 * the same two states `CourseCta` renders at the foot of an article, so the bar
 * and the article can never disagree about whether enrollment is open.
 */
export type CohortOffer = {
	kind: 'enroll' | 'waitlist'
	/** Resource id, so a caller can ask whether this viewer already owns it. */
	id: string
	title: string
	href: string
	label: string
}

/**
 * NOT personalised, on purpose. Which cohort is running is the same fact for
 * every visitor, so it is cached and safe to resolve in the root layout — no
 * `cookies()`, no `headers()`, and therefore no dynamic opt-out for the pages
 * underneath it. Everything viewer-specific (already subscribed, already
 * bought) is decided on the client and can only ever REMOVE the offer.
 */
export const getCohortOffer = unstable_cache(
	async (): Promise<CohortOffer | null> => {
		const upcoming = await getUpcomingCohort()
		if (upcoming) {
			return {
				kind: 'enroll',
				id: upcoming.id,
				title: upcoming.title,
				href: `/cohorts/${upcoming.slug}`,
				label: 'Join the cohort',
			}
		}

		const latest = await getLatestCohort()
		if (latest) {
			return {
				kind: 'waitlist',
				id: latest.id,
				title: latest.title,
				href: `/cohorts/${latest.slug}`,
				// "Join the waitlist" names the mechanism; this names the thing you
				// get. The link goes to the cohort page either way, and between
				// cohorts the next one is what the reader is actually after.
				label: 'Join next cohort',
			}
		}

		return null
	},
	['nav-cohort-offer-v1'],
	{ revalidate: 600, tags: ['products', 'cohorts'] },
)

/**
 * `getCohortOffer` for callers that must not fail with it.
 *
 * The root layout sits above every page AND above every error boundary, so an
 * exception thrown there is not a degraded nav — it is the global error page
 * instead of the site, on every route, including ones that touch no database
 * at all. `getUpcomingCohort`/`getLatestCohort` have no try/catch of their own
 * and `unstable_cache` re-throws on a miss, so a PlanetScale timeout with a
 * cold cache did exactly that.
 *
 * A missing offer is a nav without a CTA, which is what a visitor sees between
 * cohorts anyway. That is the right failure.
 *
 * The catch is deliberately OUT here rather than inside the cached function:
 * `unstable_cache` does not store a thrown result, so a transient blip stays
 * transient. Catching inside would cache `null` for the full 600s and keep the
 * CTA missing long after the database came back.
 */
export async function getCohortOfferSafe(): Promise<CohortOffer | null> {
	try {
		return await getCohortOffer()
	} catch (error) {
		await log.error('nav.cohort-offer.failed', {
			error: error instanceof Error ? error.message : 'Unknown error',
		})
		return null
	}
}
