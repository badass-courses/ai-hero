import { unstable_cache } from 'next/cache'
import { db } from '@/db'
import { contentResource } from '@/db/schema'
import { and, eq, sql } from 'drizzle-orm'

export type UpcomingCohortSummary = {
	/** Resource id — lets callers ask whether this viewer already owns it. */
	id: string
	title: string
	slug: string
	/** ISO datetime when the cohort starts, when set on the resource. */
	startsAt?: string
	/**
	 * The cohort's own IANA zone. Carried because `startsAt` is an instant and
	 * a date is not: `formatCohortDateRange` defaults to `America/Los_Angeles`
	 * when this is missing, so a caller that dropped it rendered a start date up
	 * to a day off from the one the cohort's own page showed.
	 */
	timezone?: string
	/** Cohort artwork. Every cohort has one; the homepage leads with it. */
	image?: string
	description?: string
}

function readString(obj: unknown, key: string): string | undefined {
	if (!obj || typeof obj !== 'object') return undefined
	const v = (obj as Record<string, unknown>)[key]
	return typeof v === 'string' && v.length > 0 ? v : undefined
}

/**
 * The next purchasable cohort: published + public, attached to a live product
 * whose enrollment window includes now, earliest `startsAt` first.
 *
 * Single source of truth for "the upcoming cohort" — used by the landing
 * page's `UpcomingCohort` section and the search palette's promo row.
 */
async function getUpcomingCohortUncached(): Promise<UpcomingCohortSummary | null> {
	const now = new Date().toISOString()

	const cohorts = await db.query.contentResource.findMany({
		where: and(
			eq(contentResource.type, 'cohort'),
			eq(sql`JSON_EXTRACT (${contentResource.fields}, "$.state")`, 'published'),
			eq(
				sql`JSON_EXTRACT (${contentResource.fields}, "$.visibility")`,
				'public',
			),
		),
		with: {
			resourceProducts: { with: { product: true } },
		},
	})

	const purchasable = cohorts.filter((cohort) => {
		const product = cohort.resourceProducts?.[0]?.product
		if (!product) return false
		if (product.status !== 1) return false
		const productState = readString(product.fields, 'state')
		if (productState && productState !== 'published') return false
		const openEnrollment = readString(product.fields, 'openEnrollment')
		const closeEnrollment = readString(product.fields, 'closeEnrollment')
		if (openEnrollment && openEnrollment > now) return false
		if (closeEnrollment && closeEnrollment < now) return false
		return true
	})

	// A cohort with no `startsAt` sorts LAST, not first. `?? ''` put it first,
	// because the empty string precedes every ISO date — so an unscheduled
	// placeholder outranked a genuinely scheduled cohort and became "the next
	// cohort" everywhere this feeds: the homepage section, the ⌘K promo row,
	// and the article CourseCta, rendered with no date at all.
	purchasable.sort((a, b) => {
		const aStart = readString(a.fields, 'startsAt')
		const bStart = readString(b.fields, 'startsAt')
		if (!aStart && !bStart) return 0
		if (!aStart) return 1
		if (!bStart) return -1
		return aStart.localeCompare(bStart)
	})

	const winner = purchasable[0]
	if (!winner) return null

	return {
		id: winner.id,
		title: readString(winner.fields, 'title') ?? 'Upcoming cohort',
		slug: readString(winner.fields, 'slug') ?? winner.id,
		startsAt: readString(winner.fields, 'startsAt'),
		timezone: readString(winner.fields, 'timezone'),
		image: readString(winner.fields, 'image'),
		description: readString(winner.fields, 'description'),
	}
}

/**
 * Published+public cohorts that have FINISHED, newest first.
 *
 * For the /courses catalog: someone who bought a cohort has no route back to
 * it from this site once its enrollment window shuts — the hero shows only
 * the current or next one, and /cohorts is effectively unused.
 *
 * "Past" is `endsAt`, the cohort's own end date, which every cohort carries.
 * The test matters because the caller badges these rows "Cohort ended": with
 * only `id !== excludeId` the set was "every cohort the hero isn't showing",
 * so the moment a second cohort is scheduled — one purchasable in the hero,
 * one announced behind it — the announced one would be advertised as over.
 * That reads as correct today only because every cohort in the data has in
 * fact ended.
 *
 * `startsAt` is the fallback for a cohort authored without an end date, on
 * the grounds that a cohort which has begun is at least not upcoming. One
 * with neither date is unscheduled, not past, and is left out entirely.
 *
 * `excludeId` still earns its place: `getLatestCohort` hands the hero the
 * newest cohort regardless of its window, so between cohorts the hero is
 * itself showing a finished one, and it would otherwise appear twice.
 *
 * Deliberately NOT filtered by ownership. The rows are navigation for people
 * who bought, but gating them on a purchase would make this page personal and
 * cost it its cache, and a closed cohort is public information anyway — it is
 * how a reader sees the thing has run before.
 */
async function getPastCohortsUncached(
	excludeId?: string,
): Promise<UpcomingCohortSummary[]> {
	const now = new Date().toISOString()

	const cohorts = await db.query.contentResource.findMany({
		where: and(
			eq(contentResource.type, 'cohort'),
			eq(sql`JSON_EXTRACT (${contentResource.fields}, "$.state")`, 'published'),
			eq(
				sql`JSON_EXTRACT (${contentResource.fields}, "$.visibility")`,
				'public',
			),
		),
	})

	return cohorts
		.filter((cohort) => {
			if (cohort.id === excludeId) return false
			// `endsAt` ONLY. The fallback used to be `startsAt`, on the grounds
			// that a cohort which has begun is at least not upcoming — but the
			// caller badges these rows "Cohort ended", and a cohort that started
			// last week with no end date is RUNNING, not over. Advertising a live
			// cohort as finished is the worse of the two failures; the other is a
			// row missing from a catalog list. Every cohort in the data carries
			// `endsAt`, so this drops nothing real, and a cohort authored without
			// one is genuinely unknown rather than past.
			const ended = readString(cohort.fields, 'endsAt')
			// Lexicographic on ISO-8601 UTC, the same comparison
			// `getUpcomingCohort` makes on the enrollment window above.
			return ended !== undefined && ended < now
		})
		.sort((a, b) => {
			const aStart =
				readString(a.fields, 'startsAt') ?? a.createdAt?.toISOString() ?? ''
			const bStart =
				readString(b.fields, 'startsAt') ?? b.createdAt?.toISOString() ?? ''
			return bStart.localeCompare(aStart)
		})
		.map((cohort) => ({
			id: cohort.id,
			title: (readString(cohort.fields, 'title') ?? 'Cohort').trim(),
			slug: readString(cohort.fields, 'slug') ?? cohort.id,
			startsAt: readString(cohort.fields, 'startsAt'),
			timezone: readString(cohort.fields, 'timezone'),
			image: readString(cohort.fields, 'image'),
			description: readString(cohort.fields, 'description'),
		}))
}

/**
 * The most recent published+public cohort regardless of enrollment window —
 * the waitlist target between cohorts. The /cohorts index page is effectively
 * unused (Vojta, 2026-07-14), so waitlist CTAs link straight to the latest
 * cohort's own page instead. Newest `startsAt` first (createdAt fallback).
 */
async function getLatestCohortUncached(): Promise<UpcomingCohortSummary | null> {
	const cohorts = await db.query.contentResource.findMany({
		where: and(
			eq(contentResource.type, 'cohort'),
			eq(sql`JSON_EXTRACT (${contentResource.fields}, "$.state")`, 'published'),
			eq(
				sql`JSON_EXTRACT (${contentResource.fields}, "$.visibility")`,
				'public',
			),
		),
	})
	if (cohorts.length === 0) return null

	const sorted = [...cohorts].sort((a, b) => {
		const aStart =
			readString(a.fields, 'startsAt') ?? a.createdAt?.toISOString() ?? ''
		const bStart =
			readString(b.fields, 'startsAt') ?? b.createdAt?.toISOString() ?? ''
		return bStart.localeCompare(aStart)
	})

	const winner = sorted[0]!
	return {
		id: winner.id,
		title: readString(winner.fields, 'title') ?? 'The next cohort',
		slug: readString(winner.fields, 'slug') ?? winner.id,
		startsAt: readString(winner.fields, 'startsAt'),
		timezone: readString(winner.fields, 'timezone'),
		image: readString(winner.fields, 'image'),
		description: readString(winner.fields, 'description'),
	}
}

/**
 * Cached entry points. The uncached implementations above stay module-private.
 *
 * Which cohort is running is the same fact for every visitor and changes on a
 * human timescale, but these were being re-queried per call: the root layout
 * resolves `getCohortOffer`, then `PostBody` and `CourseCta` each ran the same
 * selector again — several `contentResource.findMany` calls with a
 * `resourceProducts`/`product` join per article render, all to reach a value
 * already computed higher in the same tree.
 *
 * Caching at the SOURCE fixes every caller at once, including the ones that
 * were already wrapping these in their own cache (`getCohortOffer`, the palette
 * promo route) — nested `unstable_cache` is fine, the inner entry is simply
 * shared.
 *
 * The tradeoff is that `getUpcomingCohortUncached` reads `now` internally, so
 * an enrollment window opening or closing takes up to `revalidate` to show. At
 * 600s against windows measured in days, that is not a real edge; the tags mean
 * a cohort or product edit invalidates it immediately anyway.
 */
const _getUpcomingCohort = unstable_cache(
	getUpcomingCohortUncached,
	['upcoming-cohort-v1'],
	{ revalidate: 600, tags: ['products', 'cohorts'] },
)

const _getLatestCohort = unstable_cache(
	getLatestCohortUncached,
	['latest-cohort-v1'],
	{ revalidate: 600, tags: ['products', 'cohorts'] },
)

// The odd one out until now: same table, same predicate, same tags as the two
// above, but re-queried on every request. `excludeId` is part of the key
// because it is part of the signature; callers that filter afterwards (as
// `/courses` does) pass nothing and share the one entry.
const _getPastCohorts = unstable_cache(
	getPastCohortsUncached,
	['past-cohorts-v1'],
	{ revalidate: 600, tags: ['products', 'cohorts'] },
)

export async function getUpcomingCohort(): Promise<UpcomingCohortSummary | null> {
	return _getUpcomingCohort()
}

export async function getLatestCohort(): Promise<UpcomingCohortSummary | null> {
	return _getLatestCohort()
}

export async function getPastCohorts(
	excludeId?: string,
): Promise<UpcomingCohortSummary[]> {
	return _getPastCohorts(excludeId)
}
