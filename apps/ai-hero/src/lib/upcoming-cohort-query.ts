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
export async function getUpcomingCohort(): Promise<UpcomingCohortSummary | null> {
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

	purchasable.sort((a, b) => {
		const aStart = readString(a.fields, 'startsAt') ?? ''
		const bStart = readString(b.fields, 'startsAt') ?? ''
		return aStart.localeCompare(bStart)
	})

	const winner = purchasable[0]
	if (!winner) return null

	return {
		id: winner.id,
		title: readString(winner.fields, 'title') ?? 'Upcoming cohort',
		slug: readString(winner.fields, 'slug') ?? winner.id,
		startsAt: readString(winner.fields, 'startsAt'),
		image: readString(winner.fields, 'image'),
		description: readString(winner.fields, 'description'),
	}
}

/**
 * Every published+public cohort except one, newest `startsAt` first.
 *
 * For the /courses catalog: someone who bought a cohort has no route back to
 * it from this site once its enrollment window shuts — the hero shows only
 * the current or next one, and /cohorts is effectively unused. The excluded id
 * is whatever the hero is already showing, so the page never lists the same
 * cohort twice.
 *
 * Deliberately NOT filtered by ownership. The rows are navigation for people
 * who bought, but gating them on a purchase would make this page personal and
 * cost it its cache, and a closed cohort is public information anyway — it is
 * how a reader sees the thing has run before.
 */
export async function getPastCohorts(
	excludeId?: string,
): Promise<UpcomingCohortSummary[]> {
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
		.filter((cohort) => cohort.id !== excludeId)
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
export async function getLatestCohort(): Promise<UpcomingCohortSummary | null> {
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
		image: readString(winner.fields, 'image'),
		description: readString(winner.fields, 'description'),
	}
}
