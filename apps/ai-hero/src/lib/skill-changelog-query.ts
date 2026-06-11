import { unstable_cache } from 'next/cache'
import { db } from '@/db'
import {
	contentResource,
	contentResourceResource,
	contentResourceTag as contentResourceTagTable,
} from '@/db/schema'
import { and, asc, desc, eq, or, sql } from 'drizzle-orm'

import {
	ContentResourceSchema,
	type ContentResource,
} from '@coursebuilder/core/schemas'

import { SkillChangelogSchema, type SkillChangelog } from './skill-changelog'
import {
	SKILL_CHANGELOG_RESOURCE_TYPE,
	SKILL_CHANGELOG_SLUG_PREFIX,
} from './skill-changelog-types'

export { SKILL_CHANGELOG_RESOURCE_TYPE, SKILL_CHANGELOG_SLUG_PREFIX }

export type SkillChangelogEntry = ContentResource

function reviveDates(obj: any): any {
	if (obj === null || obj === undefined) return obj
	if (typeof obj === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(obj)) {
		const d = new Date(obj)
		return isNaN(d.getTime()) ? obj : d
	}
	if (Array.isArray(obj)) return obj.map(reviveDates)
	if (typeof obj === 'object') {
		const result: any = {}
		for (const [key, value] of Object.entries(obj)) {
			result[key] = reviveDates(value)
		}
		return result
	}
	return obj
}

const publicSkillChangelogWhere = and(
	or(
		eq(contentResource.type, SKILL_CHANGELOG_RESOURCE_TYPE),
		and(
			eq(contentResource.type, 'post'),
			or(
				eq(
					sql`JSON_EXTRACT (${contentResource.fields}, "$.postType")`,
					SKILL_CHANGELOG_RESOURCE_TYPE,
				),
				sql`JSON_UNQUOTE(JSON_EXTRACT (${contentResource.fields}, "$.slug")) LIKE ${`${SKILL_CHANGELOG_SLUG_PREFIX}%`}`,
			),
		),
	),
	eq(sql`JSON_EXTRACT (${contentResource.fields}, "$.visibility")`, 'public'),
	eq(sql`JSON_EXTRACT (${contentResource.fields}, "$.state")`, 'published'),
)

export async function getSkillChangelogEntries({
	limit = 10,
	offset = 0,
}: {
	limit?: number
	offset?: number
} = {}): Promise<SkillChangelogEntry[]> {
	const entries = await db.query.contentResource.findMany({
		where: publicSkillChangelogWhere,
		orderBy: desc(contentResource.createdAt),
		limit,
		offset,
		with: {
			resources: {
				with: { resource: true },
				orderBy: asc(contentResourceResource.position),
			},
			tags: {
				with: { tag: true },
				orderBy: asc(contentResourceTagTable.position),
			},
		},
	})

	return entries
		.map((entry) => ContentResourceSchema.safeParse(entry))
		.filter((result): result is { success: true; data: SkillChangelogEntry } =>
			Boolean(result.success),
		)
		.map((result) => result.data)
}

export async function getSkillChangelogEntry(
	slugOrId: string,
): Promise<SkillChangelogEntry | null> {
	const entry = await db.query.contentResource.findFirst({
		where: and(
			or(
				eq(sql`JSON_EXTRACT (${contentResource.fields}, "$.slug")`, slugOrId),
				eq(contentResource.id, slugOrId),
			),
			publicSkillChangelogWhere,
		),
		with: {
			resources: {
				with: { resource: true },
				orderBy: asc(contentResourceResource.position),
			},
			tags: {
				with: { tag: true },
				orderBy: asc(contentResourceTagTable.position),
			},
		},
	})

	const parsed = ContentResourceSchema.safeParse(entry)
	return parsed.success ? parsed.data : null
}

export async function getSkillChangelogCount(): Promise<number> {
	const rows = await db
		.select({ count: sql<number>`count(*)` })
		.from(contentResource)
		.where(publicSkillChangelogWhere)

	return Number(rows[0]?.count ?? 0)
}

const _getCachedSkillChangelogEntry = unstable_cache(
	async (slugOrId: string) => getSkillChangelogEntry(slugOrId),
	['skill-changelog-v1'],
	{ revalidate: 3600, tags: ['skill-changelog', 'posts'] },
)

export async function getCachedSkillChangelogEntry(slugOrId: string) {
	const result = await _getCachedSkillChangelogEntry(slugOrId)
	return result ? reviveDates(result) : null
}

const skillChangelogResourceWhere = or(
	eq(contentResource.type, SKILL_CHANGELOG_RESOURCE_TYPE),
	and(
		eq(contentResource.type, 'post'),
		or(
			eq(
				sql`JSON_EXTRACT (${contentResource.fields}, "$.postType")`,
				SKILL_CHANGELOG_RESOURCE_TYPE,
			),
			sql`JSON_UNQUOTE(JSON_EXTRACT (${contentResource.fields}, "$.slug")) LIKE ${`${SKILL_CHANGELOG_SLUG_PREFIX}%`}`,
		),
	),
)

/**
 * Loads a skill changelog by slug or id, regardless of state/visibility.
 * Caller is responsible for the auth check.
 */
export async function getSkillChangelogForEdit(
	slugOrId: string,
): Promise<SkillChangelog | null> {
	const entry = await db.query.contentResource.findFirst({
		where: and(
			or(
				eq(sql`JSON_EXTRACT (${contentResource.fields}, "$.slug")`, slugOrId),
				eq(contentResource.id, slugOrId),
			),
			skillChangelogResourceWhere,
		),
		with: {
			resources: {
				with: { resource: true },
				orderBy: asc(contentResourceResource.position),
			},
			tags: {
				with: { tag: true },
				orderBy: asc(contentResourceTagTable.position),
			},
		},
	})

	if (!entry) return null

	const parsed = SkillChangelogSchema.safeParse(entry)
	if (!parsed.success) {
		console.error(
			'[skill-changelog] parse failed for',
			slugOrId,
			parsed.error.issues,
		)
		return null
	}
	return parsed.data
}
