import * as React from 'react'
import { CohortHero } from '@/components/cohort-hero'
import {
	formatAlumniCount,
	getCachedCohortAlumniCount,
} from '@/lib/cohort-stats'
import { getCoursesHeroState } from '@/lib/courses-hero-state'
import { getLatestCohort, getUpcomingCohort } from '@/lib/upcoming-cohort-query'
import { log } from '@/server/logger'

/**
 * The cohort section on the homepage (wireframe § ⑨) — the same block `/courses`
 * leads with, not a second design of it.
 *
 * This file used to be a whole parallel composition: its own badges, its own
 * two-fact strip, its own copy for the between-cohorts state, and the cohort's
 * `description` rendered as plain text where `/courses` renders the same field
 * as markdown in accent ink. Every one of Amy's 2026-07-30 annotations on this
 * block was answered here AND again in the hero, twice, by hand.
 *
 * So there is one component now (`components/cohort-hero.tsx`) and this is the
 * homepage's data fetch for it. The only difference on the page is the heading
 * level: the cohort's name is an `h2` here because the homepage is about more
 * than the cohort, and the `h1` on `/courses` because that page is not.
 *
 * The reads are the same three `/courses` makes, and for the same reasons:
 * a purchasable cohort wins, the latest published cohort is the waitlist target
 * between cohorts (never the `/cohorts` index — standing rule), and the sale is
 * resolved server-side and guarded to this cohort's own resource id.
 *
 * Renders nothing when no cohort resolves at all, so the page degrades to the
 * sections around it.
 */
export async function UpcomingCohort() {
	const [purchasable, latest, alumniCount] = await Promise.all([
		getUpcomingCohort(),
		getLatestCohort(),
		getCachedCohortAlumniCount().catch(() => 0),
	])

	const flagship = purchasable ?? latest

	if (!flagship) {
		await log.info('landing.upcomingCohort.noMatch', {})
		return null
	}

	// Depends on the flagship (the sale is guarded to its resource id), so it
	// cannot join the batch above.
	const { sale } = await getCoursesHeroState(flagship)

	return (
		<CohortHero
			flagship={flagship}
			isPurchasable={Boolean(purchasable)}
			alumniLabel={formatAlumniCount(alumniCount)}
			sale={sale}
			headingLevel="h2"
			headingId="cohort-heading"
		/>
	)
}
