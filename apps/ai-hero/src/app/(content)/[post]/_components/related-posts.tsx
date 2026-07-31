import { getCachedListForPost } from '@/lib/lists-query'
import { getCachedPost } from '@/lib/posts-query'
import {
	contentDurationLabel,
	resolveContentDuration,
} from '@/lib/content-duration'
import { getNearestNeighbour } from '@/lib/typesense-query'
import readingTime from 'reading-time'

/**
 * W1 §1.3 — the cross-promo "related posts" data for the end of a post. The
 * rows themselves are drawn by `post-related-newsletter.tsx`, which pairs them
 * with the newsletter in one hairline grid; this file only resolves what goes
 * in them.
 *
 * Two content strategies:
 * - 'section'   (Option A, "More in {sectionTitle}") — siblings from the post's
 *   list, i.e. "stay on this arc."
 * - 'suggested' (Option B, "You might also like") — cross-topic Typesense
 *   nearest-neighbor discovery.
 *
 * Fallback: 'section' silently degrades to 'suggested' when it can't produce 2
 * items (no list, or fewer than 2 eligible siblings) so the block never renders
 * sparse. Returns null only when BOTH strategies come up empty.
 */
export type RelatedPostsVariant = 'section' | 'suggested'

export type RelatedPostsProps = {
	postId: string
	variant: RelatedPostsVariant
	/** required for 'section' variant to render the header + drive the query */
	sectionTitle?: string
	documentIdsToSkip?: string[]
	className?: string
}

/** Normalized item shape consumed by the row, from either data source. */
export type RelatedPostItem = {
	id: string
	title: string
	slug: string
	/** derived from post.fields.postType, e.g. "Skill post", "Article" */
	typeLabel: string
	/** Real video runtime or article reading time, already formatted. */
	durationLabel?: string
	/**
	 * Child resource count for collection-shaped posts (tutorials, courses,
	 * playlists). When present it REPLACES read time in the eyebrow: "6 lessons"
	 * describes a collection better than the reading time of its own body, which
	 * is usually just a short intro.
	 */
	lessonCount?: number
}

const MAX_ITEMS = 2

/**
 * Human label for the card eyebrow, derived from `fields.postType`.
 *
 * 'article' reads as "Article", not "Tutorial". An earlier wireframe used
 * "Tutorial" as its long-form label, but the CMS applies `article` to ordinary
 * posts, so the eyebrow was calling essays and news posts tutorials. The
 * prototype's related rows say "Article · 7 min read".
 */
function typeLabelForPostType(postType?: string | null): string {
	switch (postType) {
		case 'skill':
			return 'Skill post'
		case 'article':
			return 'Article'
		case 'podcast':
			return 'Podcast'
		case 'tip':
			return 'Tip'
		case 'course':
			return 'Course'
		case 'playlist':
			return 'Playlist'
		case 'skill-changelog':
			return 'Changelog'
		// The CMS's generic type. "Post" is the database's word for it; a reader
		// scanning a related row reads "Article".
		case 'post':
			return 'Article'
		default:
			if (!postType) return 'Article'
			return postType.charAt(0).toUpperCase() + postType.slice(1)
	}
}

function contentTiming(post: Awaited<ReturnType<typeof getCachedPost>>) {
	const timing = resolveContentDuration(post?.fields, post?.resources)
	return {
		...timing,
		timeToReadSeconds: post?.fields?.body
			? readingTime(post.fields.body).time / 1000
			: timing.timeToReadSeconds,
	}
}

/**
 * Child resource count, straight off the post `getCachedPost` already returns
 * (`resources` is hydrated by that query, so this costs no extra fetch).
 * Only the Option A / sibling path has it: Typesense docs carry no child data.
 */
/**
 * Child resource types that read as a "lesson" in a collection. Everything else
 * a post can hang off itself (videoResource, solution, question) is machinery,
 * not an entry a reader would count.
 */
const LESSON_CHILD_TYPES = new Set(['post', 'lesson'])

function computeLessonCount(resources?: unknown): number | undefined {
	if (!Array.isArray(resources)) return undefined
	// A post's `resources` is NOT just its lessons: an ordinary article carries
	// its videoResource/solution here, which is why a naive length counted 1
	// everywhere. Only child resources that are themselves readable/watchable
	// entries count as lessons.
	const count = resources.filter((join) =>
		LESSON_CHILD_TYPES.has(
			(join as { resource?: { type?: string } })?.resource?.type ?? '',
		),
	).length
	return count > 0 ? count : undefined
}

/**
 * Option A. Pulls siblings from the post's list (via `getCachedListForPost`),
 * excludes the current post + any skip ids, caps to 2. Returns null when it
 * can't fill 2 slots so the caller can fall back to Option B.
 */
async function resolveSection(
	postId: string,
	sectionTitle: string | undefined,
	skipIds: Set<string>,
): Promise<{ heading: string; items: RelatedPostItem[] } | null> {
	const list = await getCachedListForPost(postId).catch(() => null)
	if (!list) return null

	// Position matters, and it used to be thrown away: the current post was
	// filtered out and the FIRST two survivors taken in raw list order, so every
	// lesson in a series recommended the same two posts — usually lessons 1 and
	// 2, including to the reader already past them. Ordering by distance from
	// where the reader actually is makes "More in {series}" mean the lessons
	// around this one.
	const ordered = (list.resources ?? [])
		.map((entry: any) => entry?.resource)
		.filter(
			(resource: any) =>
				resource &&
				resource.type === 'post' &&
				typeof resource.fields?.slug === 'string',
		)

	const currentIndex = ordered.findIndex((r: any) => r.id === postId)
	const eligible = ordered.filter(
		(resource: any) => resource.id !== postId && !skipIds.has(resource.id),
	)

	// A post that is not in its own list (or a list that does not order) keeps
	// the old behaviour rather than inventing a centre to measure from.
	const siblings = (
		currentIndex === -1
			? eligible
			: [...eligible].sort(
					(a: any, b: any) =>
						Math.abs(ordered.indexOf(a) - currentIndex) -
						Math.abs(ordered.indexOf(b) - currentIndex),
				)
	).slice(0, MAX_ITEMS)

	if (siblings.length < MAX_ITEMS) return null

	const items = await Promise.all(
		siblings.map(async (resource: any): Promise<RelatedPostItem> => {
			const fields = resource.fields ?? {}
			const slug: string = fields.slug
			// The list query strips the body, so fetch the full post to compute
			// read time; capped at 2 items, and getCachedPost is cache-backed.
			const full = await getCachedPost(slug).catch(() => null)
			const timing = contentTiming(full)
			return {
				id: resource.id,
				title: fields.title ?? full?.fields?.title ?? 'Untitled',
				slug,
				typeLabel: timing.isVideo
					? 'Video'
					: typeLabelForPostType(
							fields.postType ?? full?.fields?.postType,
						),
				durationLabel: contentDurationLabel(timing),
				lessonCount: computeLessonCount(full?.resources),
			}
		}),
	)

	const heading = `More in ${sectionTitle ?? list.fields?.title ?? 'this series'}`
	return { heading, items }
}

/**
 * Option B. Pulls Typesense nearest-neighbors. `getNearestNeighbour` returns a
 * single best pick, so we call it twice with an accumulating skip list to
 * surface 2 distinct discovery items (the "use more of what's already returned"
 * path). Returns 0–2 items.
 */
async function resolveSuggested(
	postId: string,
	skipIds: Set<string>,
): Promise<{ heading: string; items: RelatedPostItem[] }> {
	const items: RelatedPostItem[] = []
	const skip = new Set(skipIds)

	for (let i = 0; i < MAX_ITEMS; i++) {
		// The neighbourhood grows with what we are excluding. A fixed k:5 was fine
		// when the skip list held an id or two, but the end of a list now excludes
		// the whole list — and a lesson's five nearest neighbours by topic are
		// mostly its own siblings, so a fixed radius could return nothing at all
		// once they were filtered out. Widening by the skip count keeps the same
		// number of real candidates in view.
		const doc = await getNearestNeighbour(
			postId,
			5 + skip.size,
			1,
			Array.from(skip),
		).catch(() => null)
		if (!doc) break

		// Typesense indexes no child resources, so a collection-shaped hit needs
		// the real post to count its lessons. Capped at MAX_ITEMS and
		// cache-backed, same as the sibling path.
		const full = await getCachedPost(doc.slug).catch(() => null)
		const timing = contentTiming(full)

		items.push({
			id: doc.id,
			title: doc.title,
			slug: doc.slug,
			typeLabel: timing.isVideo ? 'Video' : typeLabelForPostType(doc.type),
			// Typesense stores the post body in `description` (see
			// upsertPostToTypeSense), so it remains a fallback when the cached
			// post lookup misses. It is never used for a detected video.
			durationLabel: contentDurationLabel({
				...timing,
				timeToReadSeconds:
					timing.timeToReadSeconds ??
					(doc.description
						? readingTime(doc.description).time / 1000
						: undefined),
			}),
			lessonCount: computeLessonCount(full?.resources),
		})
		skip.add(doc.id)
	}

	return { heading: 'You might also like', items }
}

/**
 * Eyebrow suffix after the type label. A lesson count wins when we have one,
 * because for a collection that is the number that matters rather than how long
 * its intro takes to read. Otherwise a read time, when the item has one.
 */
function metaSuffix(item: RelatedPostItem): string {
	if (item.lessonCount) {
		return ` · ${item.lessonCount} ${item.lessonCount === 1 ? 'lesson' : 'lessons'}`
	}
	return item.durationLabel ? ` · ${item.durationLabel}` : ''
}

/**
 * The eyebrow the redesign's related row wants: "Article · 7 min read", or the
 * bare type label when the item carries no duration or lesson count. Never
 * invents a number.
 */
export function relatedItemMeta(item: RelatedPostItem): string {
	return `${item.typeLabel}${metaSuffix(item)}`
}

/**
 * The data half of `RelatedPosts`, without its old full-width section markup.
 *
 * The post page renders these rows as the left cell of the RELATED +
 * NEWSLETTER grid (`post-related-newsletter.tsx`), so it needs the items, not a
 * section. Same two strategies and the same silent 'section' → 'suggested'
 * degradation as before.
 */
export async function resolveRelatedPostItems({
	postId,
	variant,
	sectionTitle,
	documentIdsToSkip,
}: RelatedPostsProps): Promise<{
	heading: string
	items: RelatedPostItem[]
}> {
	const skipIds = new Set([postId, ...(documentIdsToSkip ?? [])])

	if (variant === 'section') {
		const section = await resolveSection(postId, sectionTitle, skipIds)
		if (section) return section
	}

	return resolveSuggested(postId, new Set(documentIdsToSkip ?? []))
}
