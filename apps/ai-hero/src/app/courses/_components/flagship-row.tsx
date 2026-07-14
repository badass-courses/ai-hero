import * as React from 'react'
import { Resource } from '@/components/landing/resource'
import { formatStartsAt } from '@/components/landing/format'
import { ResourceRow } from '@/components/landing/resource-row'
import {
	COURSES_NEWSLETTER,
	COURSE_TIERS,
	FLAGSHIP_WAITLIST,
} from '@/lib/courses-content'
import { getCachedCohort } from '@/lib/cohorts-query'
import type { UpcomingCohortSummary } from '@/lib/upcoming-cohort-query'
import { getResourcePath } from '@/utils/resource-paths'

/**
 * The Tier 2 (flagship cohort) row on /courses. Three states:
 *
 * - PURCHASABLE (enrollment open): defer entirely to `<Resource>` — live
 *   image, "Cohort · Starts {date}" label, live price + discount badge,
 *   href to the cohort page. No `badge` prop: a string badge would suppress
 *   the live DiscountBadge in resource.tsx.
 * - WAITLIST (between cohorts): a hand-fed `ResourceRow` — waitlist copy, a
 *   "Waitlist open" pill, NO price line, no stale "Starts {past date}"
 *   (dates only render when `startsAt` is in the future). Href goes to the
 *   cohort's own page — never the /cohorts index (standing rule).
 * - No cohort content at all: renders like a coming-soon row.
 */
export async function FlagshipRow({
	flagship,
	isPurchasable,
}: {
	flagship: UpcomingCohortSummary | null
	isPurchasable: boolean
}) {
	if (flagship && isPurchasable) {
		return <Resource slugOrId={flagship.slug} variant="row" />
	}

	if (flagship) {
		// Between cohorts — enrich the summary with the cached cohort resource
		// (image + timezone; cached 1h under tag 'cohort').
		const cohort = await getCachedCohort(flagship.slug)
		const startsAt = flagship.startsAt ? new Date(flagship.startsAt) : null
		const startsInFuture =
			startsAt !== null && startsAt.getTime() > Date.now()
		const timezone = cohort?.fields?.timezone ?? 'America/Los_Angeles'

		return (
			<ResourceRow
				title={flagship.title}
				description={FLAGSHIP_WAITLIST.description}
				href={getResourcePath('cohort', flagship.slug, 'view')}
				image={cohort?.fields?.image}
				typeLabel={
					startsInFuture && startsAt
						? `Cohort · Starts ${formatStartsAt(startsAt, timezone)}`
						: 'Cohort · Next dates coming soon'
				}
				badge={FLAGSHIP_WAITLIST.badge}
				fallbackPlaceholder="Cohort"
			/>
		)
	}

	// Degenerate: no published cohort content exists — fall back to a
	// coming-soon row so the roadmap never renders a hole.
	const flagshipTier = COURSE_TIERS.find((tier) => tier.status === 'flagship')!
	return (
		<ResourceRow
			title={flagshipTier.title}
			description="The flagship cohort. Join the list below to hear when the next one is scheduled."
			href={`#${COURSES_NEWSLETTER.anchorId}`}
			typeLabel={flagshipTier.audienceLabel}
			badge="Coming soon"
			fallbackPlaceholder="Coming soon"
		/>
	)
}
