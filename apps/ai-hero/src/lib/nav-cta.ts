import { unstable_cache } from 'next/cache'

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
