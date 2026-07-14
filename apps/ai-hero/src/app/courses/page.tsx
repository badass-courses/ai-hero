import type { Metadata } from 'next'
import LayoutClient from '@/components/layout-client'
import {
	getLatestCohort,
	getUpcomingCohort,
} from '@/lib/upcoming-cohort-query'

import { CoursesPage } from './_components/courses-page'

// Cohort enrollment windows are time-based (no tag to invalidate on), so the
// flagship row must resolve per-request — same call as /skills and /posts.
export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
	title: 'Learn with Matt | AI Hero',
	description:
		'Courses from Matt Pocock: a beginner AI coding crash course, the flagship AI Coding for Real Engineers cohort, and advanced training for teams. A path designed to grow with you.',
	alternates: { canonical: '/courses' },
}

export default async function CoursesRoute() {
	// Purchasable cohort wins; between cohorts the latest published cohort is
	// the waitlist target (never the /cohorts index — standing rule).
	const upcoming = await getUpcomingCohort()
	const flagship = upcoming ?? (await getLatestCohort())

	return (
		<LayoutClient withContainer>
			<CoursesPage flagship={flagship} isPurchasable={Boolean(upcoming)} />
		</LayoutClient>
	)
}
