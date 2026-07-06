import * as React from 'react'
import Link from 'next/link'
import { getCachedListForPost } from '@/lib/lists-query'
import { getCachedPost } from '@/lib/posts-query'
import { getNearestNeighbour } from '@/lib/typesense-query'
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

		items.push({
			id: doc.id,
			title: doc.title,
			slug: doc.slug,
			typeLabel: typeLabelForPostType(doc.type),
			// Typesense stores the post body in `description` (see
			// upsertPostToTypeSense), so read time is derivable without a DB hit.
			readTimeMinutes: computeReadMinutes(doc.description),
		})
		skip.add(doc.id)
	}

	return { heading: 'You might also like', items }
}

function RelatedPostCard({ item }: { item: RelatedPostItem }) {
	return (
		<Link
			href={`/${item.slug}`}
			className="group bg-card hover:bg-muted focus-visible:ring-ring relative flex flex-col gap-4 px-5 py-8 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset sm:px-8 sm:py-10"
		>
			<div className="font-mono text-[11px] font-medium uppercase tracking-wider opacity-60">
				{item.typeLabel}
				{item.readTimeMinutes ? ` · ${item.readTimeMinutes} min read` : ''}
			</div>
			<h3 className="text-balance text-xl font-semibold leading-tight tracking-tight sm:text-2xl">
				{item.title}
			</h3>
			<span className="text-muted-foreground group-hover:text-foreground mt-auto inline-flex items-center gap-1.5 pt-2 text-sm font-medium transition-colors">
				Read more
				<ArrowRight className="ease-[cubic-bezier(0.22,1,0.36,1)] size-4 transition-transform duration-300 group-hover:translate-x-1 motion-reduce:transition-none motion-reduce:group-hover:translate-x-0" />
			</span>
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
		<section
			aria-label={heading}
			className={cn('bg-background border-y', className)}
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
