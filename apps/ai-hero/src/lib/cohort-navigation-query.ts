import { db } from '@/db'
import { contentResource, contentResourceResource } from '@/db/schema'
import { log } from '@/server/logger'
import { measureIfSlow } from '@/server/perf'
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { unstable_cache } from 'next/cache'

import type { CohortNavigation, CohortWorkshopNav } from './cohort-navigation'

/**
 * The cohort's ordered workshops, with enough of each to render a "next
 * workshop" affordance: title, release state, and the first lesson to land on.
 *
 * Deliberately not `getAllWorkshopsInCohort` (`./cohorts-query`), which parses
 * every workshop through `WorkshopSchema` and *throws* when one row is
 * malformed. That is right for the cohort sales page, where a broken workshop
 * should be loud. It is wrong here: this runs on every lesson page, and one bad
 * row would take down the lesson rather than one link. This projects the four
 * fields it needs in SQL and skips rows it can't read.
 */

/** `JSON_UNQUOTE(JSON_EXTRACT(…))` on a JSON null yields the STRING 'null'. */
function readJsonString(value: string | null): string | null {
	if (value === null || value === 'null' || value === '') return null
	return value
}

const fieldsText = (path: string) =>
	sql<
		string | null
	>`JSON_UNQUOTE(JSON_EXTRACT(${contentResource.fields}, ${sql.raw(`'$.${path}'`)}))`

/**
 * One level of children, nav fields only. Mirrors `selectNavigationChildren`
 * in `./content-navigation-query` — same soft-delete guards, same ordering —
 * but that one is module-private and this file needs `type` and `title`.
 */
async function selectChildren(parentIds: string[], types: string[]) {
	if (parentIds.length === 0) return []

	return db
		.select({
			parentId: contentResourceResource.resourceOfId,
			id: contentResource.id,
			type: contentResource.type,
			slug: fieldsText('slug'),
			title: fieldsText('title'),
		})
		.from(contentResourceResource)
		.innerJoin(
			contentResource,
			eq(contentResource.id, contentResourceResource.resourceId),
		)
		.where(
			and(
				inArray(contentResourceResource.resourceOfId, parentIds),
				inArray(contentResource.type, types),
				isNull(contentResourceResource.deletedAt),
				isNull(contentResource.deletedAt),
			),
		)
		.orderBy(
			asc(contentResourceResource.resourceOfId),
			asc(contentResourceResource.position),
		)
}

export async function getCohortNavigation(
	cohortId: string,
): Promise<CohortNavigation | null> {
	return measureIfSlow({
		event: 'perf.cohort-navigation.fetch.slow',
		spanName: 'cohort-navigation.fetch',
		thresholdMs: 100,
		data: { cohortId },
		operation: async () => {
			const cohortRows = await db
				.select({
					id: contentResource.id,
					slug: fieldsText('slug'),
					title: fieldsText('title'),
				})
				.from(contentResource)
				.where(
					and(
						eq(contentResource.id, cohortId),
						eq(contentResource.type, 'cohort'),
						isNull(contentResource.deletedAt),
					),
				)
				.limit(1)

			const cohort = cohortRows[0]
			const cohortSlug = readJsonString(cohort?.slug ?? null)
			const cohortTitle = readJsonString(cohort?.title ?? null)

			if (!cohort || !cohortSlug || !cohortTitle) return null

			const workshopRows = await db
				.select({
					id: contentResource.id,
					position: contentResourceResource.position,
					slug: fieldsText('slug'),
					title: fieldsText('title'),
					state: fieldsText('state'),
					startsAt: fieldsText('startsAt'),
					timezone: fieldsText('timezone'),
				})
				.from(contentResourceResource)
				.innerJoin(
					contentResource,
					eq(contentResource.id, contentResourceResource.resourceId),
				)
				.where(
					and(
						eq(contentResourceResource.resourceOfId, cohortId),
						eq(contentResource.type, 'workshop'),
						isNull(contentResourceResource.deletedAt),
						isNull(contentResource.deletedAt),
					),
				)
				.orderBy(asc(contentResourceResource.position))

			// Unpublished workshops stay in the list. Dropping them would shift
			// every index after them, so "workshop 3 of 6" would renumber itself
			// as the cohort drops, and the last published workshop would render
			// "you finished the cohort" while three more were still to come.
			// `isWorkshopAvailable` decides what to do with them at render time.
			const workshopIds = workshopRows.map((row) => row.id)

			const level1 = await selectChildren(workshopIds, [
				'lesson',
				'post',
				'section',
			])
			const sectionIds = level1
				.filter((row) => row.type === 'section')
				.map((row) => row.id)
			const level2 = await selectChildren(sectionIds, ['lesson', 'post'])

			const childrenByParent = new Map<string, typeof level1>()
			for (const row of [...level1, ...level2]) {
				const siblings = childrenByParent.get(row.parentId)
				if (siblings) {
					siblings.push(row)
				} else {
					childrenByParent.set(row.parentId, [row])
				}
			}

			/** First playable resource, descending into the first non-empty section. */
			const resolveFirstLesson = (workshopId: string) => {
				for (const child of childrenByParent.get(workshopId) ?? []) {
					if (child.type === 'section') {
						for (const grandchild of childrenByParent.get(child.id) ?? []) {
							const slug = readJsonString(grandchild.slug)
							const title = readJsonString(grandchild.title)
							if (slug && title) return { slug, title }
						}
						continue
					}

					const slug = readJsonString(child.slug)
					const title = readJsonString(child.title)
					if (slug && title) return { slug, title }
				}

				return null
			}

			const workshops = workshopRows.flatMap<CohortWorkshopNav>((row) => {
				const slug = readJsonString(row.slug)
				const title = readJsonString(row.title)

				if (!slug || !title) {
					void log.error('cohort-navigation.workshop.incomplete', {
						cohortId,
						workshopId: row.id,
					})
					return []
				}

				return [
					{
						id: row.id,
						slug,
						title,
						position: row.position,
						state: readJsonString(row.state) ?? 'draft',
						startsAt: readJsonString(row.startsAt),
						timezone:
							readJsonString(row.timezone) ?? 'America/Los_Angeles',
						firstLesson: resolveFirstLesson(row.id),
					},
				]
			})

			return {
				id: cohort.id,
				slug: cohortSlug,
				title: cohortTitle,
				workshops,
			}
		},
	})
}

/**
 * Cached because it is per-cohort, not per-user: the same four rows serve every
 * learner on every lesson page of the cohort. Tagged alongside `cohort` so an
 * edit to the cohort's contents drops it.
 */
export const getCachedCohortNavigation = unstable_cache(
	async (cohortId: string) => getCohortNavigation(cohortId),
	['cohort-navigation'],
	{ revalidate: 3600, tags: ['cohort', 'cohort-navigation'] },
)
