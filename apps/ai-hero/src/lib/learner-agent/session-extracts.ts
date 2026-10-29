import { db } from '@/db'
import { contentResource, contentResourceResource } from '@/db/schema'
import { parseSessionExtract, type SessionExtract } from '@/lib/session-extract'
import { skillNavLabel } from '@/lib/skill-nav-label'
import type { SkillEntry } from '@/lib/skills-query'
import { log } from '@/server/logger'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { z } from 'zod'

/** Ids per query, so a large course cannot build an unbounded IN list. */
const BATCH = 100

/**
 * The session extracts of many lessons at once, read the way the lesson page
 * reads one (`getLessonSessionExtract`): `fields.sessionExtract` on each
 * lesson's video resource, parsed on its own. A malformed extract logs and
 * is left out; it never fails the rest.
 *
 * Paid content with no access check of its own: pass only lesson ids the
 * entitlements port has already opened.
 */
export async function getLessonSessionExtracts(
	lessonIds: ReadonlyArray<string>,
): Promise<Array<{ lessonId: string; extract: SessionExtract }>> {
	const ids = [...new Set(lessonIds)]
	const batches: string[][] = []
	for (let index = 0; index < ids.length; index += BATCH) {
		batches.push(ids.slice(index, index + BATCH))
	}

	const rows = (
		await Promise.all(
			batches.map((batch) =>
				db
					.select({
						lessonId: contentResourceResource.resourceOfId,
						sessionExtract: sql<unknown>`${contentResource.fields}->'$.sessionExtract'`,
					})
					.from(contentResourceResource)
					.innerJoin(
						contentResource,
						eq(contentResourceResource.resourceId, contentResource.id),
					)
					.where(
						and(
							inArray(contentResourceResource.resourceOfId, batch),
							eq(contentResource.type, 'videoResource'),
						),
					),
			),
		)
	).flat()

	// One video per lesson, as the page reads it: the first one found.
	const byLesson = new Map<string, SessionExtract>()
	for (const row of rows) {
		if (byLesson.has(row.lessonId)) continue
		const parsed = parseSessionExtract(row.sessionExtract)
		if (parsed.status === 'invalid') {
			await log.warn('lesson.session_extract.invalid', {
				lessonId: row.lessonId,
				error: z.prettifyError(parsed.error),
			})
			continue
		}
		if (parsed.extract) byLesson.set(row.lessonId, parsed.extract)
	}
	return ids.flatMap((lessonId) => {
		const extract = byLesson.get(lessonId)
		return extract ? [{ lessonId, extract }] : []
	})
}

/**
 * Each skill page under the names a session calls it by: its nav label
 * ("The /grill-me Skill" reads "/grill-me") and its slug without the
 * `skills-` prefix. The package matches either, case and slash aside.
 */
export function skillLinksFrom(
	entries: ReadonlyArray<Pick<SkillEntry, 'slug' | 'title'>>,
	baseUrl: string,
): Array<{ skill: string; url: string }> {
	return entries.flatMap((entry) => {
		const url = `${baseUrl}/${entry.slug}`
		const names = new Set([
			skillNavLabel(entry.title),
			...(entry.slug.startsWith('skills-')
				? [entry.slug.slice('skills-'.length)]
				: []),
		])
		return [...names].map((skill) => ({ skill, url }))
	})
}
