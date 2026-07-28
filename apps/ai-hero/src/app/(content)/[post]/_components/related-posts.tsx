import * as React from 'react'
import Link from 'next/link'
import { getCachedListForPost } from '@/lib/lists-query'
import { getCachedPost } from '@/lib/posts-query'
import { getNearestNeighbour } from '@/lib/typesense-query'
import { ResourceHoverFrame } from '@/components/resource-hover-frame'
import { ArrowRight } from 'lucide-react'
import readingTime from 'reading-time'

import { cn } from '@coursebuilder/utils/cn'

/**
 * W1 §1.3 — cross-promo "related posts" block rendered below an article body.
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

/** Normalized item shape consumed by the card, from either data source. */
type RelatedPostItem = {
	id: string
	title: string
	slug: string
	/** derived from post.fields.postType, e.g. "Skill post", "Tutorial" */
	typeLabel: string
	readTimeMinutes?: number
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
 * "Tutorial" maps from the 'article' postType (the wireframe's long-form label);
 * "Skill post" maps from 'skill'.
 */
function typeLabelForPostType(postType?: string | null): string {
	switch (postType) {
		case 'skill':
			return 'Skill post'
		case 'article':
			return 'Tutorial'
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
		default:
			if (!postType) return 'Article'
			return postType.charAt(0).toUpperCase() + postType.slice(1)
	}
}

function computeReadMinutes(body?: string | null): number | undefined {
	if (!body) return undefined
	const minutes = Math.round(readingTime(body).minutes)
	return minutes > 0 ? minutes : 1
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

	const siblings = (list.resources ?? [])
		.map((entry: any) => entry?.resource)
		.filter(
			(resource: any) =>
				resource &&
				resource.type === 'post' &&
				resource.id !== postId &&
				!skipIds.has(resource.id) &&
				typeof resource.fields?.slug === 'string',
		)
		.slice(0, MAX_ITEMS)

	if (siblings.length < MAX_ITEMS) return null

	const items = await Promise.all(
		siblings.map(async (resource: any): Promise<RelatedPostItem> => {
			const fields = resource.fields ?? {}
			const slug: string = fields.slug
			// The list query strips the body, so fetch the full post to compute
			// read time; capped at 2 items, and getCachedPost is cache-backed.
			const full = await getCachedPost(slug).catch(() => null)
			return {
				id: resource.id,
				title: fields.title ?? full?.fields?.title ?? 'Untitled',
				slug,
				typeLabel: typeLabelForPostType(
					fields.postType ?? full?.fields?.postType,
				),
				readTimeMinutes: computeReadMinutes(full?.fields?.body),
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
		const doc = await getNearestNeighbour(
			postId,
			5,
			1,
			Array.from(skip),
		).catch(() => null)
		if (!doc) break

		// Typesense indexes no child resources, so a collection-shaped hit needs
		// the real post to count its lessons. Capped at MAX_ITEMS and
		// cache-backed, same as the sibling path.
		const full = await getCachedPost(doc.slug).catch(() => null)

		items.push({
			id: doc.id,
			title: doc.title,
			slug: doc.slug,
			typeLabel: typeLabelForPostType(doc.type),
			// Typesense stores the post body in `description` (see
			// upsertPostToTypeSense), so read time needs no DB hit of its own.
			readTimeMinutes: computeReadMinutes(doc.description),
			lessonCount: computeLessonCount(full?.resources),
		})
		skip.add(doc.id)
	}

	return { heading: 'You might also like', items }
}

/**
 * Eyebrow suffix after the type label. A lesson count wins when we have one; a
 * tutorial shows nothing rather than a read time, since the number that matters
 * for a collection is its lesson count, not how long its intro takes to read.
 */
function metaSuffix(item: RelatedPostItem): string {
	if (item.lessonCount) {
		return ` · ${item.lessonCount} ${item.lessonCount === 1 ? 'lesson' : 'lessons'}`
	}
	if (item.typeLabel === 'Tutorial') return ''
	return item.readTimeMinutes ? ` · ${item.readTimeMinutes} min read` : ''
}

function RelatedPostCard({ item }: { item: RelatedPostItem }) {
	return (
		// `group/resource` + `relative` are what ResourceHoverFrame anchors to, so
		// this card gets the same signature gradient frame as the Up Next card
		// (DESIGN.md rule 13) instead of its own bespoke bg-muted hover.
		<Link
			href={`/${item.slug}`}
			className="group/resource group bg-card focus-visible:ring-ring relative flex flex-col focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset"
		>
			<ResourceHoverFrame
				surfaceClassName="bg-card"
				className="flex h-full flex-col gap-4 px-5 py-8 sm:px-8 sm:py-10"
			>
				<div className="font-mono text-[11px] font-medium uppercase tracking-wider opacity-60">
					{item.typeLabel}
					{metaSuffix(item)}
				</div>
				<h3 className="text-balance text-xl font-semibold leading-tight tracking-tight sm:text-2xl">
					{item.title}
				</h3>
				<span className="text-muted-foreground group-hover:text-foreground mt-auto inline-flex items-center gap-1.5 pt-2 text-sm font-medium transition-colors">
					Read more
					<ArrowRight className="ease-[cubic-bezier(0.22,1,0.36,1)] size-4 transition-transform duration-300 group-hover:translate-x-1 motion-reduce:transition-none motion-reduce:group-hover:translate-x-0" />
				</span>
			</ResourceHoverFrame>
		</Link>
	)
}

export async function RelatedPosts({
	postId,
	variant,
	sectionTitle,
	documentIdsToSkip,
	className,
}: RelatedPostsProps): Promise<React.JSX.Element | null> {
	const skipIds = new Set([postId, ...(documentIdsToSkip ?? [])])

	let heading: string
	let items: RelatedPostItem[]

	if (variant === 'section') {
		const section = await resolveSection(postId, sectionTitle, skipIds)
		if (section) {
			;({ heading, items } = section)
		} else {
			// Fewer than 2 siblings (or no list): fall through to Option B so the
			// block never renders sparse.
			;({ heading, items } = await resolveSuggested(
				postId,
				new Set(documentIdsToSkip ?? []),
			))
		}
	} else {
		;({ heading, items } = await resolveSuggested(
			postId,
			new Set(documentIdsToSkip ?? []),
		))
	}

	if (items.length === 0) return null

	// Keep the 2-up grid's trailing hairline clean when only one item survived.
	const fillerCount = items.length % 2 === 0 ? 0 : 1

	return (
		// `border-t` only, never `border-y`. This is the last block on a post
		// page, and the global footer already owns a `border-t` — a bottom rule
		// here lands on exactly the same pixel row and renders as a 2px line
		// (DESIGN rule 1: consecutive sections SHARE one hairline). Nothing above
		// this section emits a bottom rule, so the top one is still ours to draw.
		<section
			aria-label={heading}
			className={cn('bg-background border-t', className)}
		>
			<div className="px-5 pb-6 pt-10 sm:px-8 sm:pt-12">
				<h2 className="text-balance text-2xl font-semibold leading-tight tracking-tight sm:text-3xl">
					{heading}
				</h2>
			</div>
			<div className="border-border bg-border grid grid-cols-1 gap-px border-t sm:grid-cols-2">
				{items.map((item) => (
					<RelatedPostCard key={item.id} item={item} />
				))}
				{Array.from({ length: fillerCount }).map((_, i) => (
					<div
						key={`filler-${i}`}
						aria-hidden
						className="bg-background hidden sm:block"
					/>
				))}
			</div>
		</section>
	)
}
