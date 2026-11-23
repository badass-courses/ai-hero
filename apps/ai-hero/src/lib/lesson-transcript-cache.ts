import 'server-only'

import { revalidateTag, unstable_cache } from 'next/cache'
import { db } from '@/db'
import { contentResource, contentResourceResource } from '@/db/schema'
import { log } from '@/server/logger'
import { measureIfSlow } from '@/server/perf'
import { sql } from 'drizzle-orm'

import { parseLessonVideoTranscriptRows } from './lesson-transcript'

export const LESSON_TRANSCRIPT_TAG = 'lesson-video-transcript'

export const lessonTranscriptTag = (lessonId: string) =>
	`lesson-video-transcript:${lessonId}`

export function invalidateLessonTranscript(tag: string) {
	try {
		revalidateTag(tag, 'max')
	} catch (error) {
		// A cache error must not change the outcome of an already committed write.
		void log.error('lesson.transcript.invalidate_failed', {
			tag,
			error: error instanceof Error ? error.message : String(error),
		})
	}
}

async function readLessonVideoTranscriptOrThrow(lessonIdOrSlug: string) {
	const query = sql`SELECT cr_video.fields->>'$.transcript' AS transcript
		FROM ${contentResource} AS cr_lesson
		JOIN ${contentResourceResource} AS crr ON cr_lesson.id = crr.resourceOfId
		JOIN ${contentResource} AS cr_video ON crr.resourceId = cr_video.id

		WHERE (cr_lesson.id = ${lessonIdOrSlug} OR JSON_UNQUOTE(JSON_EXTRACT(cr_lesson.fields, '$.slug')) = ${lessonIdOrSlug})
			AND cr_video.type = 'videoResource'
		LIMIT 1;`
	const result = await db.execute(query)
	const parsedResult = parseLessonVideoTranscriptRows(result.rows)

	if (parsedResult.status === 'invalid') {
		await log.warn('lesson.transcript.invalid', {
			lessonIdOrSlug,
			rowCount: Array.isArray(result.rows) ? result.rows.length : null,
			error:
				parsedResult.error.issues
					.map(({ path, message }) => `${path.join('.') || 'root'}: ${message}`)
					.join('; ') || parsedResult.error.message,
		})
	}

	return parsedResult.transcript
}

function measureTranscriptRead<T>(
	lessonIdOrSlug: string,
	operation: () => Promise<T>,
) {
	return measureIfSlow({
		event: 'perf.lesson.transcript.slow',
		spanName: 'lesson.transcript.fetch',
		thresholdMs: 100,
		data: { lessonIdOrSlug },
		operation,
	})
}

async function logFetchFailure(lessonIdOrSlug: string, error: unknown) {
	await log.error('lesson.transcript.fetch_failed', {
		lessonIdOrSlug,
		error: error instanceof Error ? error.message : String(error),
		stack: error instanceof Error ? error.stack : undefined,
	})
	return null
}

export function getUncachedLessonVideoTranscript(lessonIdOrSlug: string) {
	return measureTranscriptRead(lessonIdOrSlug, () =>
		readLessonVideoTranscriptOrThrow(lessonIdOrSlug).catch((error) =>
			logFetchFailure(lessonIdOrSlug, error),
		),
	)
}

// Paid content with no access check of its own. Call only after the lesson
// access check. Do not re-export this loader from a 'use server' module.
export function getCachedLessonVideoTranscript(lessonId: string) {
	return unstable_cache(
		() =>
			measureTranscriptRead(lessonId, () =>
				readLessonVideoTranscriptOrThrow(lessonId),
			),
		['lesson-video-transcript-v1', lessonId],
		{
			revalidate: 600,
			tags: [LESSON_TRANSCRIPT_TAG, lessonTranscriptTag(lessonId)],
		},
	)().catch((error) => logFetchFailure(lessonId, error))
}
