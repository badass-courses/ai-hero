import { db } from '@/db'
import { contentResource, contentResourceResource } from '@/db/schema'
import { and, eq, isNull, or, sql } from 'drizzle-orm'

/**
 * How far a requested time may sit from an authored one. The search index
 * stores `thumbnail_time` rounded to whole seconds (see `video-facts.ts`), so
 * /videos cards ask for up to half a second off the authored frame.
 */
const AUTHORED_TOLERANCE_SECONDS = 0.5

/**
 * The frame the thumbnail route may serve. The route is public and its
 * responses are cached forever, and video ids reach signed-out viewers (the
 * navigation, the end card's Up next), so it must not hand out arbitrary
 * frames of a paid video: only frame 0 or a poster frame an author chose.
 * Anything else falls back to the default poster.
 */
export function resolveThumbnailTime(
	requested: string | null,
	authoredTimes: number[],
	fallback: number,
): number {
	if (requested === null) return fallback
	const time = Number(requested)
	if (!Number.isFinite(time) || time < 0) return fallback
	if (time === 0) return 0
	const isAuthored = authoredTimes.some(
		(authored) => Math.abs(authored - time) <= AUTHORED_TOLERANCE_SECONDS,
	)
	return isAuthored ? time : fallback
}

/**
 * Every poster time authored for a video: its own, each resource that holds
 * it (a lesson, a solution, a post), and a resource that points at it through
 * `fields.videoResourceId`. The same links the video facts follow.
 */
export async function getAuthoredThumbnailTimes(
	videoResourceId: string,
): Promise<number[]> {
	const thumbnailTime = sql<
		number | null
	>`CAST(JSON_EXTRACT(${contentResource.fields}, '$.thumbnailTime') AS DOUBLE)`

	const rows = await db
		.selectDistinct({ thumbnailTime })
		.from(contentResource)
		.leftJoin(
			contentResourceResource,
			and(
				eq(contentResourceResource.resourceOfId, contentResource.id),
				eq(contentResourceResource.resourceId, videoResourceId),
				isNull(contentResourceResource.deletedAt),
			),
		)
		.where(
			and(
				isNull(contentResource.deletedAt),
				or(
					eq(contentResource.id, videoResourceId),
					eq(contentResourceResource.resourceId, videoResourceId),
					eq(
						sql`JSON_UNQUOTE(JSON_EXTRACT(${contentResource.fields}, '$.videoResourceId'))`,
						videoResourceId,
					),
				),
			),
		)

	return rows.flatMap(({ thumbnailTime }) => {
		// Unset is NULL, which Number() would turn into a frame 0 it never was.
		if (thumbnailTime === null) return []
		const time = Number(thumbnailTime)
		return Number.isFinite(time) && time >= 0 ? [time] : []
	})
}
