import { db } from '@/db'
import { contentResource, contentResourceResource } from '@/db/schema'
import { and, inArray, isNull, sql } from 'drizzle-orm'

import {
	computeVideoFacts,
	type VideoFacts,
	type VideoGraph,
} from './video-facts'

const GRAPH_TYPES = [
	'cohort',
	'workshop',
	'section',
	'list',
	'tutorial',
	'post',
	'lesson',
	'exercise',
	'tip',
	'talk',
	'videoResource',
]

function jsonString(key: string) {
	return sql<
		string | null
	>`JSON_UNQUOTE(JSON_EXTRACT(${contentResource.fields}, ${`$.${key}`}))`
}

function jsonNumber(key: string) {
	return sql<
		number | null
	>`CAST(JSON_EXTRACT(${contentResource.fields}, ${`$.${key}`}) AS DOUBLE)`
}

/**
 * The slice of the content graph the video facts are derived from: every
 * resource that can hold or be a video, and every join between them. Reads only
 * the few `fields` keys the rules need — post bodies stay in the database.
 */
export async function loadVideoGraph(): Promise<VideoGraph> {
	const [nodes, edges] = await Promise.all([
		db
			.select({
				id: contentResource.id,
				type: contentResource.type,
				title: jsonString('title'),
				state: jsonString('state'),
				visibility: jsonString('visibility'),
				startsAt: jsonString('startsAt'),
				videoResourceId: jsonString('videoResourceId'),
				duration: jsonNumber('duration'),
				muxPlaybackId: jsonString('muxPlaybackId'),
				thumbnailTime: jsonNumber('thumbnailTime'),
			})
			.from(contentResource)
			.where(
				and(
					inArray(contentResource.type, GRAPH_TYPES),
					isNull(contentResource.deletedAt),
				),
			),
		db
			.select({
				parentId: contentResourceResource.resourceOfId,
				childId: contentResourceResource.resourceId,
				tier: sql<
					string | null
				>`JSON_UNQUOTE(JSON_EXTRACT(${contentResourceResource.metadata}, '$.tier'))`,
			})
			.from(contentResourceResource)
			.where(isNull(contentResourceResource.deletedAt)),
	])

	return { nodes, edges }
}

/**
 * Fresh facts for one resource, for the save-time index path. Loads the whole
 * graph because a resource's facts depend on its neighbours; the graph is a
 * few thousand narrow rows. `null` for anything that is not itself a video
 * (a cohort, a workshop), which then carries no video facts at all.
 */
export async function getVideoFactsForResource(
	resourceId: string,
): Promise<VideoFacts | null> {
	const facts = computeVideoFacts(await loadVideoGraph())
	return facts.get(resourceId) ?? null
}
