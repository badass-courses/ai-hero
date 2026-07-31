'use server'

import { unstable_cache } from 'next/cache'
import { db } from '@/db'
import { tag as tagTable } from '@/db/schema'
import { log } from '@/server/logger'
import { eq, sql } from 'drizzle-orm'

import { TagSchema, type Tag } from './tags'

/**
 * Resolve a *topic* tag by `fields.slug`. Returns `null` for unknown slugs AND
 * for tags whose `fields.contexts` includes `'skill-phase'` — phase tags
 * (W2's skill-cycle phases) are not topics, and `/topics/[slug]` must 404 for
 * them. Use `getPostsByTag` in `posts-query.ts` when phase tags should
 * resolve.
 */
export async function getTopicTag(slug: string): Promise<Tag | null> {
	try {
		const row = await db.query.tag.findFirst({
			where: eq(sql`JSON_EXTRACT (${tagTable.fields}, "$.slug")`, slug),
		})

		if (!row) return null

		const parsed = TagSchema.safeParse(row)
		if (!parsed.success) {
			void log.error('topic.tag.parse.error', {
				slug,
				error: parsed.error.message,
			})
			return null
		}

		if (parsed.data.fields.contexts?.includes('skill-phase')) return null

		return parsed.data
	} catch (error) {
		void log.error('topic.tag.query.error', {
			slug,
			error: error instanceof Error ? error.message : String(error),
		})
		return null
	}
}

const _getCachedTopicTag = unstable_cache(
	async (slug: string) => getTopicTag(slug),
	['topic-tag-v1'],
	{ revalidate: 3600, tags: ['tags'] },
)

/**
 * Cached `getTopicTag`. Re-parses through `TagSchema` after the cache read to
 * revive `Date` fields serialized across the `unstable_cache` boundary
 * (same posture as `getCachedAllPosts`'s `reviveDates`).
 */
export async function getCachedTopicTag(slug: string): Promise<Tag | null> {
	const result = await _getCachedTopicTag(slug)
	if (!result) return null

	const parsed = TagSchema.safeParse(result)
	return parsed.success ? parsed.data : null
}
