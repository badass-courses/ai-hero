import type { ResourceNavigation } from './content-navigation'

/**
 * Cohort-level navigation: the shape a lesson page needs to answer "what comes
 * after this workshop?".
 *
 * A workshop's own navigation (`getContentNavigation`) stops at the workshop
 * boundary — its `parents` are the *products* the workshop is sold in, and a
 * cohort product carries the cohort resource but not the cohort's other
 * workshops. So the sibling list is a separate read; see
 * `./cohort-navigation-query`. This module holds only the types and the pure
 * rules, so client components can import it.
 */

export type CohortWorkshopNav = {
	id: string
	slug: string
	title: string
	/** Authored order within the cohort, 0-based (the join row's position). */
	position: number
	/** `published` workshops are the only ones a learner may be sent to. */
	state: string
	/** ISO string. Null means "no release date, available as soon as published". */
	startsAt: string | null
	timezone: string
	/** Where "start this workshop" actually goes — its first lesson. */
	firstLesson: { slug: string; title: string } | null
}

export type CohortNavigation = {
	id: string
	slug: string
	title: string
	workshops: CohortWorkshopNav[]
}

/** The cohort a workshop belongs to, read off its navigation `parents`. */
export type NavigationCohort = {
	id: string
	slug: string
	title: string
}

/**
 * Digs the cohort out of a workshop's navigation.
 *
 * `parents` is a list of products; `type: 'cohort'` is the *product* type, and
 * the cohort content resource is one of that product's resources. Three call
 * sites used to inline this walk with three slightly different guards.
 */
export function getCohortFromNavigation(
	navigation: ResourceNavigation | null | undefined,
): NavigationCohort | null {
	const cohortProduct = navigation?.parents?.find(
		(parent) => parent?.type === 'cohort',
	)

	if (!cohortProduct) return null

	const cohortResource = cohortProduct.resources?.find(
		(relation: { resource?: { type?: string } }) =>
			relation?.resource?.type === 'cohort',
	)?.resource

	const id = cohortResource?.id
	const slug = cohortResource?.fields?.slug
	const title = cohortResource?.fields?.title

	if (!id || !slug || !title) return null

	return { id, slug, title }
}

/**
 * Whether a learner can be sent into this workshop yet.
 *
 * Two gates, and both have to be here rather than at the call site: cohort
 * workshops are authored ahead of time as drafts and published on release, AND
 * they carry a `startsAt`. Checking only the date links to a 404 the week
 * before a drop; checking only the state links to a published-but-embargoed
 * workshop. Entitlement is NOT checked here — the destination route already
 * enforces it, and duplicating that check client-side would need a per-user
 * round trip on every lesson page.
 */
export function isWorkshopAvailable(
	workshop: CohortWorkshopNav,
	now: Date = new Date(),
): boolean {
	if (workshop.state !== 'published') return false
	if (!workshop.startsAt) return true

	const startsAt = new Date(workshop.startsAt)
	// An unparseable date is authoring noise, not an embargo. Failing open
	// matches `formatCohortDateRange`, which renders nothing for a bad date.
	if (Number.isNaN(startsAt.getTime())) return true

	return startsAt <= now
}

/**
 * The workshop immediately after `workshopId` in cohort order, or null when
 * this is the last one (or the cohort doesn't contain it at all).
 *
 * Returns the next workshop even when it is locked — the caller renders the
 * "unlocks on…" state from it, which is more use than an empty card.
 */
export function getNextCohortWorkshop(
	cohortNavigation: CohortNavigation | null | undefined,
	workshopId: string | null | undefined,
): CohortWorkshopNav | null {
	if (!cohortNavigation || !workshopId) return null

	const index = cohortNavigation.workshops.findIndex((w) => w.id === workshopId)
	if (index === -1) return null

	return cohortNavigation.workshops[index + 1] ?? null
}

/**
 * 1-based position of a workshop in its cohort, for "Workshop 2 of 6".
 * Null when the workshop isn't part of the cohort list.
 */
export function getCohortWorkshopPosition(
	cohortNavigation: CohortNavigation | null | undefined,
	workshopId: string | null | undefined,
): { index: number; total: number } | null {
	if (!cohortNavigation || !workshopId) return null

	const index = cohortNavigation.workshops.findIndex((w) => w.id === workshopId)
	if (index === -1) return null

	return { index: index + 1, total: cohortNavigation.workshops.length }
}
