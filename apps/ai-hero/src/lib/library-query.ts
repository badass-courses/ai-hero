import { db } from '@/db'
import {
	contentResource,
	contentResourceProduct,
	products,
	purchases,
} from '@/db/schema'
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm'

import { isWorkshopAvailable } from './cohort-navigation'
import { getCachedCohortNavigation } from './cohort-navigation-query'
import { flattenNavigationResources } from './content-navigation'
import { getModuleProgressForUser } from './progress'
import { getCachedWorkshopNavigation } from './workshops-query'

/**
 * What someone owns, and where they left off in it.
 *
 * The list of purchases already existed on the profile page, but every row led
 * to a marketing page — so "seeing the courses I've bought and can continue"
 * meant landing on the sales page for something you had already bought, and
 * finding your place by hand. An entry here carries a destination that names
 * the actual next lesson.
 */

const LIBRARY_PURCHASE_STATUSES = ['Valid', 'Restricted'] as const

export type LibraryEntry = {
	key: string
	title: string
	/** The cohort a workshop sits in, when the entry is one workshop of one. */
	contextLabel: string | null
	/** The overview: the cohort or workshop page. */
	href: string
	/** Where the learner actually wants to go. Null when there is nothing to play. */
	cta: { label: string; href: string } | null
	completedLessons: number
	totalLessons: number
	percent: number
	status: 'not-started' | 'in-progress' | 'complete'
	purchasedAt: Date | null
}

type PurchasedResource = {
	key: string
	resourceId: string | null
	resourceType: string | null
	resourceSlug: string | null
	title: string
	purchasedAt: Date | null
}

/**
 * Every distinct thing this user has bought, newest first.
 *
 * A product can carry several resources and a user can buy the same product
 * twice (a personal seat plus a team seat), so rows are deduped on the resource
 * they grant.
 */
async function getPurchasedResources(
	userId: string,
): Promise<PurchasedResource[]> {
	const rows = await db
		.select({
			purchaseId: purchases.id,
			productId: purchases.productId,
			productName: products.name,
			purchasedAt: purchases.createdAt,
			resourceId: contentResource.id,
			resourceType: contentResource.type,
			// Routes key off `fields.slug`; the column is the fallback. They agree
			// in production today, and preferring the one the router uses means a
			// drift shows up as a stale label rather than a broken link.
			resourceSlug: sql<
				string | null
			>`COALESCE(JSON_UNQUOTE(JSON_EXTRACT(${contentResource.fields}, '$.slug')), ${contentResource.slug})`,
			resourceTitle: sql<
				string | null
			>`JSON_UNQUOTE(JSON_EXTRACT(${contentResource.fields}, '$.title'))`,
		})
		.from(purchases)
		.leftJoin(products, eq(purchases.productId, products.id))
		.leftJoin(
			contentResourceProduct,
			and(
				eq(contentResourceProduct.productId, purchases.productId),
				isNull(contentResourceProduct.deletedAt),
			),
		)
		.leftJoin(
			contentResource,
			eq(contentResource.id, contentResourceProduct.resourceId),
		)
		.where(
			and(
				eq(purchases.userId, userId),
				inArray(purchases.status, [...LIBRARY_PURCHASE_STATUSES]),
			),
		)
		.orderBy(desc(purchases.createdAt), asc(contentResourceProduct.position))

	const seen = new Set<string>()

	return rows.flatMap((row) => {
		const key = row.resourceId || row.productId || row.purchaseId
		if (!key || seen.has(key)) return []
		seen.add(key)

		return [
			{
				key,
				resourceId: row.resourceId,
				resourceType: row.resourceType,
				resourceSlug: row.resourceSlug,
				title:
					row.resourceTitle?.trim() || row.productName || 'Purchased course',
				purchasedAt: row.purchasedAt ?? null,
			},
		]
	})
}

/**
 * The title of the lesson `getModuleProgressForUser` picked as next.
 *
 * The adapter's progress query returns `nextResource` with an id, a type and a
 * slug but no title, and a CTA that says "Continue" is worth much less than one
 * that says "Continue: Permissions". The navigation it reads from is the same
 * cached tree every lesson page already loads.
 */
async function getResourceTitle(
	workshopSlug: string,
	resourceId: string | null | undefined,
): Promise<string | null> {
	if (!resourceId) return null

	const navigation = await getCachedWorkshopNavigation(workshopSlug)
	const resource = flattenNavigationResources(navigation).find(
		(r) => r.id === resourceId,
	)

	return resource?.fields?.title ?? null
}

function statusFor(
	completed: number,
	total: number,
): LibraryEntry['status'] {
	if (total > 0 && completed >= total) return 'complete'
	return completed > 0 ? 'in-progress' : 'not-started'
}

/** "Continue: Permissions" beats "Continue" — name the thing you get. */
function ctaFor(
	status: LibraryEntry['status'],
	lessonTitle: string | null,
	lessonHref: string | null,
	overviewHref: string,
): LibraryEntry['cta'] {
	if (status === 'complete') return { label: 'Review', href: overviewHref }
	if (!lessonHref) return null

	const verb = status === 'not-started' ? 'Start' : 'Continue'
	return {
		label: lessonTitle ? `${verb}: ${lessonTitle}` : verb,
		href: lessonHref,
	}
}

async function buildWorkshopEntry(
	purchase: PurchasedResource,
	options: { contextLabel?: string | null; workshopSlug: string; title: string },
): Promise<LibraryEntry> {
	const progress = await getModuleProgressForUser(options.workshopSlug)
	const completed = progress?.completedLessonsCount ?? 0
	const total = progress?.totalLessonsCount ?? 0
	const status = statusFor(completed, total)
	const overviewHref = `/workshops/${options.workshopSlug}`

	const nextSlug = progress?.nextResource?.fields?.slug ?? null
	const nextTitle = await getResourceTitle(
		options.workshopSlug,
		progress?.nextResource?.id,
	)

	return {
		key: purchase.key,
		title: options.title,
		contextLabel: options.contextLabel ?? null,
		href: overviewHref,
		cta: ctaFor(
			status,
			nextTitle,
			nextSlug ? `/workshops/${options.workshopSlug}/${nextSlug}` : null,
			overviewHref,
		),
		completedLessons: completed,
		totalLessons: total,
		percent: total > 0 ? Math.round((completed / total) * 100) : 0,
		status,
		purchasedAt: purchase.purchasedAt,
	}
}

/**
 * A cohort is one entry, not eight. It is sold and understood as one course,
 * so the card carries the cohort's total progress and points at the next lesson
 * of whichever workshop is currently in play — the whole point being that the
 * learner never has to work out which workshop that is.
 */
async function buildCohortEntry(
	purchase: PurchasedResource,
	cohortId: string,
): Promise<LibraryEntry | null> {
	const cohort = await getCachedCohortNavigation(cohortId)
	if (!cohort) return null

	const overviewHref = `/cohorts/${cohort.slug}`
	const progressByWorkshop = await Promise.all(
		cohort.workshops.map(async (workshop) => ({
			workshop,
			progress: await getModuleProgressForUser(workshop.slug),
		})),
	)

	const completed = progressByWorkshop.reduce(
		(sum, { progress }) => sum + (progress?.completedLessonsCount ?? 0),
		0,
	)
	const total = progressByWorkshop.reduce(
		(sum, { progress }) => sum + (progress?.totalLessonsCount ?? 0),
		0,
	)
	const status = statusFor(completed, total)

	// The workshop in play: the first released one that isn't finished. Skipping
	// unreleased workshops matters — their progress is 0/0, so without the check
	// a cohort mid-drop would always point at the workshop that hasn't landed.
	const current = progressByWorkshop.find(
		({ workshop, progress }) =>
			isWorkshopAvailable(workshop) &&
			(progress?.totalLessonsCount ?? 0) > 0 &&
			(progress?.percentCompleted ?? 0) < 100,
	)

	const nextSlug = current?.progress?.nextResource?.fields?.slug ?? null
	const nextTitle = current
		? await getResourceTitle(
				current.workshop.slug,
				current.progress?.nextResource?.id,
			)
		: null

	return {
		key: purchase.key,
		title: cohort.title,
		contextLabel: current ? current.workshop.title : null,
		href: overviewHref,
		cta: ctaFor(
			status,
			nextTitle,
			current && nextSlug
				? `/workshops/${current.workshop.slug}/${nextSlug}`
				: null,
			overviewHref,
		),
		completedLessons: completed,
		totalLessons: total,
		percent: total > 0 ? Math.round((completed / total) * 100) : 0,
		status,
		purchasedAt: purchase.purchasedAt,
	}
}

/** Something owned that we can't compute progress for — still worth listing. */
function buildPlainEntry(purchase: PurchasedResource): LibraryEntry {
	const href = purchase.resourceSlug
		? `/${purchase.resourceSlug}`
		: '/workshops'

	return {
		key: purchase.key,
		title: purchase.title,
		contextLabel: null,
		href,
		// No progress to report, but a card with no action at all reads as a
		// dead entry — the one thing this page is meant to stop doing.
		cta: { label: 'Open', href },
		completedLessons: 0,
		totalLessons: 0,
		percent: 0,
		status: 'not-started',
		purchasedAt: purchase.purchasedAt,
	}
}

/** In-progress first, then unstarted, then finished; newest purchase breaks ties. */
const STATUS_ORDER: Record<LibraryEntry['status'], number> = {
	'in-progress': 0,
	'not-started': 1,
	complete: 2,
}

export async function getLibraryEntries(
	userId: string,
): Promise<LibraryEntry[]> {
	const purchased = await getPurchasedResources(userId)

	const entries = await Promise.all(
		purchased.map(async (purchase) => {
			if (purchase.resourceType === 'cohort' && purchase.resourceId) {
				return buildCohortEntry(purchase, purchase.resourceId)
			}

			if (
				(purchase.resourceType === 'workshop' ||
					purchase.resourceType === 'tutorial') &&
				purchase.resourceSlug
			) {
				return buildWorkshopEntry(purchase, {
					workshopSlug: purchase.resourceSlug,
					title: purchase.title,
				})
			}

			return buildPlainEntry(purchase)
		}),
	)

	return entries
		.filter((entry): entry is LibraryEntry => entry !== null)
		.sort((a, b) => {
			const byStatus = STATUS_ORDER[a.status] - STATUS_ORDER[b.status]
			if (byStatus !== 0) return byStatus
			return (b.purchasedAt?.getTime() ?? 0) - (a.purchasedAt?.getTime() ?? 0)
		})
}
