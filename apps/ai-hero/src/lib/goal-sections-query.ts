import { unstable_cache } from 'next/cache'
import { db } from '@/db'
import { contentResource } from '@/db/schema'
import { log } from '@/server/logger'
import { and, desc, eq, inArray, or, sql } from 'drizzle-orm'

/**
 * Server-side resolution for the `/learn` Map page (W3 §5).
 *
 * Two cached readers over the existing `'posts'` cache tag:
 * - `getCachedGoalSectionItems` batch-resolves the flat slug list referenced
 *   across the goal-section config in ONE query (no N+1), keyed by slug.
 * - `getCachedFeaturedWhatsNew` returns the most recent published+public posts
 *   in the same fuller shape for the What's New featured row.
 *
 * The video-vs-article signal is structural (joined `videoResource` child with
 * a `muxPlaybackId`, or a `youtubeUrl`/`youtube` field) — the SAME signal
 * `src/components/landing/resource.tsx`'s `resolveReference` uses. Per spec
 * §Open-Q6 this duplicates a narrow, read-only slice of that logic rather than
 * refactoring the widely-consumed `resource.tsx` component.
 */

export type ResolvedItem = {
	/** post slug (also the flat root URL segment) */
	slug: string
	title: string
	description?: string
	/** post subtype label (`fields.postType`, e.g. 'article' | 'skill'); falls back to the resource type */
	type: string
	/** flat root URL, `/${slug}` — all Map-linked posts live at flat root URLs */
	href: string
	/** cover/mux/youtube thumbnail, or null when none resolves */
	thumbnailUrl?: string | null
	/** true when a joined videoResource (muxPlaybackId) or a youtube field is present */
	isVideo: boolean
	/** e.g. "12 min read" (articles) or "8 min" (video), when derivable */
	durationLabel?: string
	/** publish date for the What's New row (fields.publishedAt, else createdAt) */
	publishedAt?: Date | null
	summary?: string
}

// --- narrow read-only field helpers (duplicated from resource.tsx per §Open-Q6) ---

function readString(obj: unknown, key: string): string | undefined {
	if (!obj || typeof obj !== 'object') return undefined
	const v = (obj as Record<string, unknown>)[key]
	return typeof v === 'string' && v.length > 0 ? v : undefined
}

function readNumber(obj: unknown, key: string): number | undefined {
	if (!obj || typeof obj !== 'object') return undefined
	const v = (obj as Record<string, unknown>)[key]
	return typeof v === 'number' ? v : undefined
}

function readImageUrl(obj: unknown, key: string): string | undefined {
	if (!obj || typeof obj !== 'object') return undefined
	const v = (obj as Record<string, unknown>)[key]
	if (typeof v === 'string' && v.length > 0) return v
	if (v && typeof v === 'object' && 'url' in v) {
		const url = (v as Record<string, unknown>).url
		if (typeof url === 'string' && url.length > 0) return url
	}
	return undefined
}

function muxThumbnailUrl(playbackId: string, thumbnailTime?: number) {
	const time = typeof thumbnailTime === 'number' ? `&time=${thumbnailTime}` : ''
	return `https://image.mux.com/${playbackId}/thumbnail.jpg?width=720&height=405&fit_mode=smartcrop${time}`
}

const YOUTUBE_ID_PATTERNS = [
	/youtube\.com\/watch\?v=([\w-]{11})/,
	/youtu\.be\/([\w-]{11})/,
	/youtube\.com\/embed\/([\w-]{11})/,
	/youtube\.com\/shorts\/([\w-]{11})/,
]

function youtubeVideoId(url: string): string | null {
	for (const pattern of YOUTUBE_ID_PATTERNS) {
		const match = url.match(pattern)
		if (match?.[1]) return match[1]
	}
	return null
}

function youtubeThumbnailUrl(url: string): string | null {
	const id = youtubeVideoId(url)
	if (!id) return null
	const youtubeThumb = `https://i.ytimg.com/vi/${id}/maxresdefault.jpg`
	const cloud = process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME
	if (!cloud) return youtubeThumb
	return `https://res.cloudinary.com/${cloud}/image/fetch/c_fill,w_720,h_405,q_auto,f_auto/${youtubeThumb}`
}

function buildDurationLabel(
	fields: unknown,
	isVideo: boolean,
): string | undefined {
	const duration = readNumber(fields, 'duration')
	const timeToRead = readNumber(fields, 'timeToRead')
	if (isVideo && duration && duration > 0) {
		return `${Math.max(1, Math.round(duration / 60))} min`
	}
	if (timeToRead && timeToRead > 0) {
		return `${Math.max(1, Math.round(timeToRead / 60))} min read`
	}
	return undefined
}

/** Row shape from the resolution query — mirror of resolveReference's join. */
type ResolvedRow = {
	type: string
	fields: unknown
	createdAt: Date | null
	resources?: Array<{
		resource?: { type: string; fields: unknown } | null
	}> | null
}

function toResolvedItem(resource: ResolvedRow): ResolvedItem | null {
	const title = readString(resource.fields, 'title')
	const slug = readString(resource.fields, 'slug')
	if (!title || !slug) return null

	const description =
		readString(resource.fields, 'description') ||
		readString(resource.fields, 'summary')
	const summary =
		readString(resource.fields, 'summary') ||
		readString(resource.fields, 'description')

	const type = readString(resource.fields, 'postType') ?? resource.type

	// Structural video signal — same as resource.tsx's resolveReference.
	const videoResource = resource.resources?.find(
		(r) => r.resource?.type === 'videoResource',
	)?.resource
	const muxPlaybackId = videoResource
		? readString(videoResource.fields, 'muxPlaybackId')
		: undefined
	const youtubeSource =
		readString(resource.fields, 'youtubeUrl') ||
		readString(resource.fields, 'youtube')
	const isVideo = Boolean(muxPlaybackId) || Boolean(youtubeSource)

	const thumbnailTime = readNumber(resource.fields, 'thumbnailTime')
	let image =
		readImageUrl(resource.fields, 'image') ||
		readImageUrl(resource.fields, 'coverImage')
	if (!image && muxPlaybackId) image = muxThumbnailUrl(muxPlaybackId, thumbnailTime)
	if (!image && youtubeSource) {
		image = youtubeThumbnailUrl(youtubeSource) ?? undefined
	}

	const publishedAtStr = readString(resource.fields, 'publishedAt')
	const publishedAt = publishedAtStr
		? new Date(publishedAtStr)
		: (resource.createdAt ?? null)

	return {
		slug,
		title,
		description,
		summary,
		type,
		href: `/${slug}`,
		thumbnailUrl: image ?? null,
		isVideo,
		durationLabel: buildDurationLabel(resource.fields, isVideo),
		publishedAt,
	}
}

const publishedPublic = () =>
	and(
		eq(sql`JSON_EXTRACT (${contentResource.fields}, "$.state")`, 'published'),
		eq(sql`JSON_EXTRACT (${contentResource.fields}, "$.visibility")`, 'public'),
	)

async function resolveItemsBySlugs(slugs: string[]): Promise<ResolvedItem[]> {
	if (slugs.length === 0) return []
	try {
		const rows = await db.query.contentResource.findMany({
			where: and(
				or(
					inArray(
						sql`JSON_EXTRACT (${contentResource.fields}, "$.slug")`,
						slugs,
					),
					inArray(contentResource.id, slugs),
				),
				publishedPublic(),
			),
			with: { resources: { with: { resource: true } } },
		})

		return rows
			.map((row) => toResolvedItem(row as ResolvedRow))
			.filter((item): item is ResolvedItem => item !== null)
	} catch (error) {
		await log.error('goal-sections.resolve.error', {
			slugCount: slugs.length,
			error: error instanceof Error ? error.message : String(error),
		})
		return []
	}
}

async function resolveFeaturedWhatsNew(limit: number): Promise<ResolvedItem[]> {
	try {
		const rows = await db.query.contentResource.findMany({
			where: and(eq(contentResource.type, 'post'), publishedPublic()),
			orderBy: desc(contentResource.createdAt),
			with: { resources: { with: { resource: true } } },
			limit,
		})

		return rows
			.map((row) => toResolvedItem(row as ResolvedRow))
			.filter((item): item is ResolvedItem => item !== null)
	} catch (error) {
		await log.error('goal-sections.whats-new.error', {
			limit,
			error: error instanceof Error ? error.message : String(error),
		})
		return []
	}
}

// Cache boundary JSON-serializes Date fields to strings; revive them after the
// read, matching the `getCachedAllPosts` idiom in posts-query.ts.
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

const _getCachedGoalSectionItems = unstable_cache(
	async (slugs: string[]) => resolveItemsBySlugs(slugs),
	['goal-section-items-v1'],
	{ revalidate: 3600, tags: ['posts'] },
)

/**
 * Batch-resolve a flat slug list in one query, keyed by resolved slug. Only
 * published + public resources are returned; unresolved slugs are simply absent
 * from the map (the page renders a fallback / skips them). Cached on the
 * `'posts'` tag; a `Map` isn't JSON-serializable so the cached layer holds an
 * array and this wrapper rebuilds the map after reviving dates.
 */
export async function getCachedGoalSectionItems(
	slugs: string[],
): Promise<Map<string, ResolvedItem>> {
	const result = await _getCachedGoalSectionItems(slugs)
	const items: ResolvedItem[] = reviveDates(result)
	const map = new Map<string, ResolvedItem>()
	for (const item of items) map.set(item.slug, item)
	return map
}

const _getCachedFeaturedWhatsNew = unstable_cache(
	async (limit: number) => resolveFeaturedWhatsNew(limit),
	['featured-whats-new-v1'],
	{ revalidate: 3600, tags: ['posts'] },
)

/**
 * Most-recent published + public posts (newest `createdAt` first) in the fuller
 * `ResolvedItem` shape (thumbnail / type / date / summary) for the What's New
 * featured row. Same query family as `HubLayout`'s `getCachedAllPosts`; both
 * ride the `'posts'` tag and Next dedupes within a render pass.
 */
export async function getCachedFeaturedWhatsNew(
	limit = 3,
): Promise<ResolvedItem[]> {
	const result = await _getCachedFeaturedWhatsNew(limit)
	return reviveDates(result)
}
