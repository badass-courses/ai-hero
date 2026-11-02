import { db } from '@/db'
import { contentResource } from '@/db/schema'
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm'

/** `JSON_UNQUOTE(JSON_EXTRACT(…))` on a JSON null yields the STRING 'null'. */
export function readJsonString(value: string | null | undefined): string | null {
	if (value === null || value === undefined || value === 'null' || value === '')
		return null
	return value
}

export const fieldsText = (path: string) =>
	sql<
		string | null
	>`JSON_UNQUOTE(JSON_EXTRACT(${contentResource.fields}, ${sql.raw(`'$.${path}'`)}))`

export type CourseResource = {
	id: string
	type: 'cohort' | 'workshop'
	slug: string
	title: string
	state: string
	startsAt: string | null
}

/**
 * A cohort or workshop by id or slug: the few fields the learner surface
 * needs to name it and decide whether it is open, and nothing heavier.
 */
export async function getCourseResource(
	idOrSlug: string,
): Promise<CourseResource | null> {
	const rows = await db
		.select({
			id: contentResource.id,
			type: contentResource.type,
			slug: fieldsText('slug'),
			title: fieldsText('title'),
			state: fieldsText('state'),
			startsAt: fieldsText('startsAt'),
		})
		.from(contentResource)
		.where(
			and(
				or(
					eq(contentResource.id, idOrSlug),
					sql`JSON_UNQUOTE(JSON_EXTRACT(${contentResource.fields}, '$.slug')) = ${idOrSlug}`,
				),
				inArray(contentResource.type, ['cohort', 'workshop']),
				isNull(contentResource.deletedAt),
			),
		)
		.limit(1)

	const row = rows[0]
	const slug = readJsonString(row?.slug)
	const title = readJsonString(row?.title)
	if (
		!row ||
		!slug ||
		!title ||
		(row.type !== 'cohort' && row.type !== 'workshop')
	)
		return null

	return {
		id: row.id,
		type: row.type,
		slug,
		title,
		state: readJsonString(row.state) ?? 'draft',
		startsAt: readJsonString(row.startsAt),
	}
}
