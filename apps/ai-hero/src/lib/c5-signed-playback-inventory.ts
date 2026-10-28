import { sql } from 'drizzle-orm'
import { contentResource, contentResourceResource } from '../db/schema'
import { SIGNED_PLAYBACK_COHORT } from './signed-playback'

/** Shared read scope for the runtime and operator script. No product/user reads. */
export function c5SignedPlaybackInventoryQuery() {
	return sql`
		WITH RECURSIVE tree AS (
			SELECT id, type, CAST(NULL AS CHAR(255)) AS workshopId,
				CAST(NULL AS CHAR(255)) AS lessonId, 0 AS depth
			FROM ${contentResource}
			WHERE id = ${SIGNED_PLAYBACK_COHORT} AND type = 'cohort' AND deletedAt IS NULL
			UNION ALL
			SELECT child.id, child.type,
				CASE WHEN child.type = 'workshop' THEN child.id ELSE tree.workshopId END,
				CASE WHEN child.type IN ('lesson', 'exercise', 'solution') THEN child.id ELSE tree.lessonId END,
				tree.depth + 1
			FROM tree
			JOIN ${contentResourceResource} edge ON edge.resourceOfId = tree.id AND edge.deletedAt IS NULL
			JOIN ${contentResource} child ON child.id = edge.resourceId AND child.deletedAt IS NULL
			WHERE tree.depth < 8 AND child.type IN ('workshop', 'section', 'lesson', 'exercise', 'solution', 'videoResource')
				AND COALESCE(edge.metadata->>'$.tier', '') <> 'free'
				AND (child.type NOT IN ('lesson', 'exercise', 'solution')
					OR COALESCE(child.fields->>'$.visibility', '') <> 'public')
		)
		SELECT DISTINCT video.id AS resourceId, tree.lessonId, tree.workshopId,
			video.fields->>'$.muxAssetId' AS assetId,
			video.fields->>'$.muxPlaybackId' AS publicPlaybackId,
			video.fields->>'$.muxSignedPlaybackId' AS signedPlaybackId
		FROM tree JOIN ${contentResource} video ON video.id = tree.id
		WHERE tree.type = 'videoResource' AND tree.lessonId IS NOT NULL AND tree.workshopId IS NOT NULL
	`
}

export type C5PlaybackRow = {
	resourceId: string
	lessonId: string
	workshopId: string
	assetId: string | null
	publicPlaybackId: string | null
	signedPlaybackId: string | null
}
