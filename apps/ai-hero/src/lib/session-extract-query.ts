import 'server-only'
import { db } from '@/db'
import { contentResource, contentResourceResource } from '@/db/schema'
import { log } from '@/server/logger'
import { sql } from 'drizzle-orm'
import { z } from 'zod'

import { parseSessionExtract } from './session-extract'

/**
 * The agent session shown in the lesson's video (`fields.sessionExtract` on
 * the video resource, owned by course sync). Parsed on its own: a malformed
 * extract logs and hides the panel, never the lesson.
 *
 * Paid content with no access check of its own: call it only after the
 * lesson's access check. It lives outside the `'use server'` lessons-query
 * module so it can never be reached as a Server Action.
 */
export async function getLessonSessionExtract(lessonId?: string | null) {
	if (!lessonId) return null

	try {
		const query = sql`SELECT cr_video.fields->'$.sessionExtract' AS sessionExtract
			FROM ${contentResource} AS cr_lesson
			JOIN ${contentResourceResource} AS crr ON cr_lesson.id = crr.resourceOfId
			JOIN ${contentResource} AS cr_video ON crr.resourceId = cr_video.id
			WHERE cr_lesson.id = ${lessonId}
				AND cr_video.type = 'videoResource'
			LIMIT 1;`
		const result = await db.execute(query)
		const row = result.rows[0] as { sessionExtract?: unknown } | undefined
		const parsed = parseSessionExtract(row?.sessionExtract)

		if (parsed.status === 'invalid') {
			await log.warn('lesson.session_extract.invalid', {
				lessonId,
				error: z.prettifyError(parsed.error),
			})
		}

		return parsed.extract
	} catch (error) {
		await log.error('lesson.session_extract.fetch_failed', {
			lessonId,
			error: error instanceof Error ? error.message : String(error),
		})
		return null
	}
}
