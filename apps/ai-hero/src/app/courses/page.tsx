import type { Metadata } from 'next'
import LayoutClient from '@/components/layout-client'
import {
	formatAlumniCount,
	getCachedCohortAlumniCount,
} from '@/lib/cohort-stats'
import { COURSES_COMING_NEXT } from '@/lib/courses-content'
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
	// Excluding whatever the hero shows, so the page never lists a cohort twice.
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
				comingNext={
					comingNextWorkshop
						? { image: comingNextWorkshop.fields?.coverImage?.url }
						: null
				}
			/>
		</LayoutClient>
	)
}
