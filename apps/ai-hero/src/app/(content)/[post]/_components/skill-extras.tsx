/**
 * SkillExtras — the skill-specific sections appended BELOW the normal post body
 * for `postType: 'skill'` posts. Rendered by `PostPage` after `<PostBody>` under
 * a `postType === 'skill' &&` gate (Vojta, 2026-07-06) — NOT a separate page
 * template. Skill posts render through the ordinary post path (video, title,
 * ToC, body, newsletter, next-up all intact); these are the extras on top.
 *
 * Sections: `<SkillActions>` (install-all, "see it on a real project", and the
 * prev / you-are-here / next trio). It degrades to nothing when its data is
 * absent (no list entry → no pager), so a skill post never renders a broken
 * extras region.
 *
 * Related reading used to be a second section here. It is now the left cell of
 * the page's RELATED + NEWSLETTER grid (`post-related-newsletter.tsx`), so this
 * file only resolves those items — `getRelatedSkillPosts` — and `PostPage`
 * renders them.
 *
 * The mini-flow, install block and free-lesson CTA used to be three sections
 * here. They are one now: they were three stacked bands asking three things,
 * and `SkillActions` says the same three things in one.
 *
 * All skill data is CMS-owned via `getSkillEntries()` (list order + phase tags +
 * synced taglines).
 */

import * as React from 'react'
import {
	contentDurationLabel,
	resolveContentDuration,
} from '@/lib/content-duration'
import { type Post } from '@/lib/posts'
import { getCachedPost, getCachedPostsByTag } from '@/lib/posts-query'
import { getSkillEntries, isSkillPhaseTag } from '@/lib/skills-query'
import { SkillActions, getSkillNeighbors } from '@/components/skills'
import readingTime from 'reading-time'

import { type PostRelatedItem } from '../../_components/post-related-newsletter'

export async function SkillExtras({ post }: { post: Post }) {
	const slug = String(post.fields?.slug ?? '')

	// CMS-owned skill data. When this post isn't a list member, `neighbors` is
	// undefined and the pager simply doesn't render.
	const entries = await getSkillEntries()
	const neighbors = getSkillNeighbors(entries, slug)

	return (
		<SkillActions
			slug={slug}
			prev={neighbors?.prev}
			current={neighbors?.current}
			next={neighbors?.next}
		/>
	)
}

/**
 * Collects up to 2 related posts from the skill post's own non-phase (topic)
 * tags via `getCachedPostsByTag`. Excludes the skill post itself; dedupes
 * across tags. Returns [] gracefully when the post has no topic tags or none
 * match (empty state, never an error).
 */
export async function getRelatedSkillPosts(
	post: Post,
): Promise<PostRelatedItem[]> {
	const topicTagSlugs = (post.tags ?? [])
		.map((entry) => entry.tag)
		.filter((tag) => tag && !isSkillPhaseTag(tag))
		.map((tag) => tag.fields.slug)

	if (topicTagSlugs.length === 0) return []

	const seen = new Set<string>([post.id])
	const collected: PostRelatedItem[] = []

	for (const tagSlug of topicTagSlugs) {
		if (collected.length >= 2) break
		const posts = await getCachedPostsByTag(tagSlug, {
			excludePostIds: [post.id],
			limit: 4,
		}).catch(() => [])
		for (const related of posts) {
			if (collected.length >= 2) break
			if (seen.has(related.id)) continue
			const relatedSlug = related.fields?.slug
			if (typeof relatedSlug !== 'string') continue
			const full = await getCachedPost(relatedSlug).catch(() => null)
			seen.add(related.id)
			collected.push({
				id: related.id,
				title: String(related.fields?.title ?? 'Untitled'),
				slug: relatedSlug,
				meta: relatedMeta(full ?? related),
			})
		}
	}

	return collected
}

/**
 * "Skill · 2 min read" for text, "Video · 8 min" when there is a real runtime,
 * or a bare "Video" when there is not. Transcript length never stands in for
 * video length.
 */
function relatedMeta(post: Post): string {
	const timing = resolveContentDuration(post.fields, post.resources)
	const label = timing.isVideo
		? 'Video'
		: post.fields?.postType === 'skill'
			? 'Skill'
			: 'Article'
	const body = post.fields?.body
	const durationLabel = contentDurationLabel({
		...timing,
		timeToReadSeconds: body
			? readingTime(body).time / 1000
			: timing.timeToReadSeconds,
	})
	return durationLabel ? `${label} · ${durationLabel}` : label
}
