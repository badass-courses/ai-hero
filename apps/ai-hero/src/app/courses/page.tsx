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
	const [upcoming, alumniCount, comingNextWorkshop] = await Promise.all([
		getUpcomingCohort(),
		getCachedCohortAlumniCount(),
		getCachedMinimalWorkshop(COURSES_COMING_NEXT.slug),
	])
	const flagship = upcoming ?? (await getLatestCohort())
	// Excluding whatever the hero shows, so the page never lists a cohort
	// twice. Sequential because the id to exclude is `flagship`'s.
	const pastCohorts = await getPastCohorts(flagship?.id)

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
