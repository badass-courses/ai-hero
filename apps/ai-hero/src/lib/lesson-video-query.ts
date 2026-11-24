import 'server-only'

import { db } from '@/db'
import { contentResource, contentResourceResource } from '@/db/schema'
import { log } from '@/server/logger'
import { measureIfSlow } from '@/server/perf'
import { sql } from 'drizzle-orm'
import { z } from 'zod'

import { VideoChapterSchema } from '@coursebuilder/core/schemas/video-resource'

import { getUncachedLessonVideoTranscript } from './lesson-transcript-cache'

function formatZodError(error: z.ZodError): string {
	return (
		error.issues
			.map((issue) => {
				const path = issue.path.length ? issue.path.join('.') : 'root'
				return `${path}: ${issue.message}`
			})
			.join('; ') || error.message
	)
}

export const getLessonVideoTranscript = async (
	lessonIdOrSlug?: string | null,
) => {
	return lessonIdOrSlug ? getUncachedLessonVideoTranscript(lessonIdOrSlug) : null
}

const LessonVideoPlaybackResourceSchema = z.object({
	id: z.string(),
	muxPlaybackId: z.string().nullable().optional(),
	muxSignedPlaybackId: z.string().nullable().optional(),
	chapters: z.preprocess((value) => {
		if (typeof value !== 'string') return value
		try {
			return JSON.parse(value)
		} catch {
			return value
		}
	}, z.array(VideoChapterSchema).nullable().optional()),
})

export const getLessonVideoPlaybackResource = async (
	lessonIdOrSlug: string,
) => {
	return measureIfSlow({
		event: 'perf.lesson.video-playback-resource.slow',
		spanName: 'lesson.video-playback-resource.fetch',
		thresholdMs: 100,
		data: { lessonIdOrSlug },
		operation: async () => {
			const query = sql`SELECT
					cr_video.id AS id,
					cr_video.fields->>'$.muxPlaybackId' AS muxPlaybackId,
					cr_video.fields->>'$.muxSignedPlaybackId' AS muxSignedPlaybackId,
					JSON_EXTRACT(cr_video.fields, '$.chapters') AS chapters
				FROM ${contentResource} AS cr_lesson
				JOIN ${contentResourceResource} AS crr ON cr_lesson.id = crr.resourceOfId
				JOIN ${contentResource} AS cr_video ON crr.resourceId = cr_video.id
				WHERE (cr_lesson.id = ${lessonIdOrSlug} OR JSON_UNQUOTE(JSON_EXTRACT(cr_lesson.fields, '$.slug')) = ${lessonIdOrSlug})
					AND cr_video.type = 'videoResource'
				LIMIT 1;`
			const result = await db.execute(query)

			const parsedResult = z
				.array(LessonVideoPlaybackResourceSchema)
				.safeParse(result.rows)

			if (!parsedResult.success) {
				await log.error('lesson.video-playback-resource.error', {
					lessonId: lessonIdOrSlug,
					slug: lessonIdOrSlug,
					error: formatZodError(parsedResult.error),
				})
				return null
			}

			return parsedResult.data[0] ?? null
		},
	})
}
