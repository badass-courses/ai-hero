import type { Metadata } from 'next'
import LayoutClient from '@/components/layout-client'
import {
	formatAlumniCount,
	getCachedCohortAlumniCount,
} from '@/lib/cohort-stats'
import { COURSES_COMING_NEXT } from '@/lib/courses-content'
import { getCoursesHeroState } from '@/lib/courses-hero-state'
import { getNextOfferSafe } from '@/lib/next-offer'
import {
	getLatestCohort,
	getPastCohorts,
	getUpcomingCohort,
} from '@/lib/upcoming-cohort-query'
import { getCachedMinimalWorkshop } from '@/lib/workshops-query'

import { CoursesPage } from './_components/courses-page'

// Cohort enrollment windows are time-based (no tag to invalidate on), so the
// flagship row must resolve per-request — same call as /skills and /posts.
export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
	title: 'Learn with Matt | AI Hero',
	description:
		'Courses from Matt Pocock: the flagship AI Coding for Real Engineers cohort, built for working engineers who want agents to write code they would put their name on.',
	alternates: { canonical: '/courses' },
}

export default async function CoursesRoute() {
	// Purchasable cohort wins; between cohorts the latest published cohort is
	// the waitlist target (never the /cohorts index — standing rule).
	//
	// All four run together. `getPastCohorts` looks like it depends on the
	// flagship, but `excludeId` only ever filters rows already in memory — it
	// does not shape the query — so waiting for the flagship bought nothing and
	// cost a full round-trip on a `force-dynamic` page. The exclusion happens
	// below instead. `getLatestCohort` is fetched unconditionally for the same
	// reason: it is a cached read, and speculatively resolving it is cheaper than
	// serializing it behind `upcoming`.
	const [upcoming, latest, alumniCount, comingNextWorkshop, allPastCohorts] =
		await Promise.all([
			getUpcomingCohort(),
			getLatestCohort(),
			getCachedCohortAlumniCount(),
			getCachedMinimalWorkshop(COURSES_COMING_NEXT.slug),
			getPastCohorts(),
		])

	const flagship = upcoming ?? latest

	// Depends on the flagship (the sale is guarded to its resource id, and the
	// running window is read off its cohort), so it cannot join the batch above.
	// `getNextOfferSafe` joins it because it is the same cached read the hero
	// state resolves internally — a second call is a cache hit, not a query.
	const [{ sale, running }, offer] = await Promise.all([
		getCoursesHeroState(flagship),
		getNextOfferSafe(),
	])

	// The hero follows the offer ladder (`next-offer.ts`). When the top offer
	// is the self-paced workshop — a live sale on it, or its waitlist while no
	// cohort is purchasable — the workshop IS the hero, and the cohort takes a
	// card in the grid instead of pitching a closed enrollment above the thing
	// a reader can actually buy. The id check keeps a sale on the cohort (or
	// any other resource) from hijacking the slot.
	const featuredWorkshopOffer =
		!upcoming &&
		offer &&
		(offer.kind === 'sale' || offer.kind === 'workshop-waitlist') &&
		comingNextWorkshop &&
		offer.id === comingNextWorkshop.id
			? offer
			: null

	// The flagship never sits on the past shelf: it is either the hero, or —
	// when the workshop leads — the catalog's cohort card (`CoursesPage`).
	// Either way the page lists it exactly once.
	const pastCohorts = flagship
		? allPastCohorts.filter((cohort) => cohort.id !== flagship.id)
		: allPastCohorts

	return (
		<LayoutClient withContainer>
			<CoursesPage
				flagship={flagship}
				isPurchasable={Boolean(upcoming)}
				alumniLabel={formatAlumniCount(alumniCount)}
				pastCohorts={pastCohorts}
				sale={sale}
				running={running}
				featuredWorkshopOffer={featuredWorkshopOffer}
				comingNextWorkshop={comingNextWorkshop}
			/>
		</LayoutClient>
	)
}
