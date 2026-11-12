import 'server-only'

import { cache } from 'react'
import { getLessonThumbnailUrl } from '@/app/(content)/_components/next-lesson'
import { db } from '@/db'
import { contentResource } from '@/db/schema'
import { getCachedLesson } from '@/lib/lessons-query'
import { inArray, sql } from 'drizzle-orm'

import type { PrerequisiteItem } from './types'

export type PrerequisiteLesson = Omit<PrerequisiteItem, 'reason'>

/**
 * A prerequisite resolves exactly when its link would open a lesson: the
 * lesson route looks the slug up with `getCachedLesson` and 404s on a miss.
 * No `state` filter: synced lessons stay `draft` while live. Whether the
 * viewer may watch it is the destination's call (`canViewLesson` there), the
 * same as for any lesson link.
 *
 * Reads: one `getCachedLesson` per link (shared with the lesson route and
 * cached across requests), then ONE read for the video durations.
 */
const loadVideoDurations = cache(async (videoIdKey: string) => {
	const rows = await db
		.select({
			id: contentResource.id,
			duration: sql<
				number | null
			>`CAST(JSON_EXTRACT(${contentResource.fields}, '$.duration') AS DOUBLE)`,
		})
		.from(contentResource)
		.where(inArray(contentResource.id, videoIdKey.split('\n')))
	return new Map(rows.map((row) => [row.id, row.duration]))
})

function videoIdOf(lesson: { resources?: Array<any> | null }) {
	return (
		lesson.resources?.find((r) => r.resource?.type === 'videoResource')
			?.resourceId ?? null
	)
}

/** Resolves every link, or returns null when any lesson is missing. */
export async function getPrerequisiteLessons(
	links: Array<{ module: string; lesson: string }>,
): Promise<PrerequisiteLesson[] | null> {
	const lessons = await Promise.all(
		links.map((link) => getCachedLesson(link.lesson)),
	)
	if (lessons.some((lesson) => !lesson?.fields?.title)) return null

	const videoIds = [
		...new Set(lessons.flatMap((lesson) => videoIdOf(lesson!) ?? [])),
	].sort()
	const durations = videoIds.length
		? await loadVideoDurations(videoIds.join('\n'))
		: new Map<string, number | null>()

	return links.map((link, index) => {
		const lesson = lessons[index]!
		const videoId = videoIdOf(lesson)
		const duration = videoId ? durations.get(videoId) : null
		const thumbnailUrl = getLessonThumbnailUrl(lesson)
		return {
			lessonId: lesson.id,
			title: lesson.fields!.title!,
			href: `/workshops/${link.module}/${link.lesson}`,
			thumbnailUrl: thumbnailUrl && `${thumbnailUrl}&width=720`,
			durationSeconds:
				duration != null && Number.isFinite(Number(duration))
					? Math.round(Number(duration))
					: null,
		}
	})
}
