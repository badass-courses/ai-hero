/**
 * SkillExtras — the skill-specific sections appended BELOW the normal post body
 * for `postType: 'skill'` posts. Rendered by `PostPage` after `<PostBody>` under
 * a `postType === 'skill' &&` gate (Vojta, 2026-07-06) — NOT a separate page
 * template. Skill posts render through the ordinary post path (video, title,
 * ToC, body, newsletter, next-up all intact); these are the extras on top.
 *
 * Sections: cycle mini-flow (prev → current → next, with the phase label) →
 * install block → free-lesson CTA → related-by-tag posts. Each degrades to
 * nothing when its data is absent (no list entry → no mini-flow/phase; no topic
 * tags → no related), so a skill post never renders a broken extras region.
 *
 * All skill data is CMS-owned via `getSkillEntries()` (list order + phase tags +
 * synced taglines).
 */

import * as React from 'react'
import Link from 'next/link'
import { InstallCommand } from '@/app/(content)/skills/_components/install-command'
import { type Post } from '@/lib/posts'
import { getCachedPostsByTag } from '@/lib/posts-query'
import { SKILLS_FREE_LESSON, SKILLS_HERO } from '@/lib/skills-content'
import { getSkillEntries, isSkillPhaseTag, type SkillEntry } from '@/lib/skills-query'
import { ResourceHoverFrame } from '@/components/resource-hover-frame'
import { ArrowLeft, ArrowRight } from 'lucide-react'

import { cn } from '@coursebuilder/utils/cn'

/** Strip a leading `skills-` prefix so the slash-command hint reads `/grill-me`. */
function invocationName(slug: string): string {
	return slug.replace(/^skills-/, '')
}

export async function SkillExtras({ post }: { post: Post }) {
	const slug = String(post.fields?.slug ?? '')

	// CMS-owned skill data. When this post isn't a list member, `entry` is
	// undefined and the phase/mini-flow simply don't render.
	const entries = await getSkillEntries()
	const entry = entries.find((e) => e.slug === slug)
	const phaseLabel = entry?.phase?.label ?? null
	const neighbors = getSkillNeighbors(entries, slug)
	const relatedPosts = await getRelatedSkillPosts(post)

	return (
		<>
			<SkillMiniFlow neighbors={neighbors} phaseLabel={phaseLabel} />
			<SkillInstallBlock slug={slug} />
			<FreeLessonCta />
			<SkillRelatedPosts posts={relatedPosts} />
		</>
	)
}

/**
 * Install block: the shared repo install command plus a per-skill invocation
 * hint. Reuses the existing `InstallCommand` (skills landing owns it) verbatim.
 */
function SkillInstallBlock({ slug }: { slug: string }) {
	const command = invocationName(slug)

	return (
		<section className="border-t">
			<div className="mx-auto flex w-full max-w-4xl flex-col gap-4 px-5 py-12 md:px-10 lg:px-14">
				<h2 className="text-2xl font-medium leading-tight tracking-tight sm:text-3xl">
					Add this skill
				</h2>
				<InstallCommand command={SKILLS_HERO.installCommand} />
				<p className="text-muted-foreground text-base leading-relaxed">
					Then type{' '}
					<code className="bg-muted/80 rounded px-1 font-mono text-[85%]">
						/{command}
					</code>{' '}
					in your coding agent.
				</p>
			</div>
		</section>
	)
}

/** Free-lesson CTA (editable destination — see `SKILLS_FREE_LESSON`). */
function FreeLessonCta() {
	return (
		<section className="border-t">
			<div className="mx-auto flex w-full max-w-4xl flex-col items-center gap-4 px-5 py-12 text-center md:px-10 lg:px-14">
				<h2 className="text-balance text-2xl font-medium leading-tight tracking-tight sm:text-3xl">
					{SKILLS_FREE_LESSON.label}
				</h2>
				{SKILLS_FREE_LESSON.description ? (
					<p className="text-muted-foreground max-w-2xl text-balance text-base leading-relaxed">
						{SKILLS_FREE_LESSON.description}
					</p>
				) : null}
				<Link
					href={SKILLS_FREE_LESSON.href}
					className="bg-primary text-primary-foreground hover:bg-primary/90 focus-visible:ring-ring group inline-flex w-fit items-center gap-2 rounded-full px-6 py-3 text-sm font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
				>
					Start lesson
					<ArrowRight className="ease-[cubic-bezier(0.22,1,0.36,1)] size-4 transition-transform duration-300 group-hover:translate-x-1 motion-reduce:transition-none motion-reduce:group-hover:translate-x-0" />
				</Link>
			</div>
		</section>
	)
}

type SkillNeighbors = {
	current: SkillEntry
	prev: SkillEntry
	next: SkillEntry
} | null

/**
 * Derives the workflow mini-flow (prev → current → next) from the list-ordered
 * skill entries, wrapping around the cycle (e.g. 7 → 1). Returns null when the
 * current slug isn't in the list or there's only one entry — no fabricated flow.
 */
function getSkillNeighbors(entries: SkillEntry[], slug: string): SkillNeighbors {
	const index = entries.findIndex((e) => e.slug === slug)
	if (index === -1 || entries.length < 2) return null

	const n = entries.length
	const current = entries[index]
	const prev = entries[(index - 1 + n) % n]
	const next = entries[(index + 1) % n]
	if (!current || !prev || !next) return null

	return { current, prev, next }
}

/** Prev → current → next strip, each neighbor a flat `/slug` link. */
function SkillMiniFlow({
	neighbors,
	phaseLabel,
}: {
	neighbors: SkillNeighbors
	phaseLabel: string | null
}) {
	if (!neighbors) return null

	const { prev, current, next } = neighbors

	return (
		// mt, not pt: the gap belongs BETWEEN the article body and this block, so
		// the rule has to move down with it. Padding would have pulled the label
		// away from a hairline still sitting tight against the body.
		<section
			aria-label="Skill workflow position"
			className="mt-12 border-t sm:mt-16"
		>
			<div className="flex flex-wrap items-center gap-3 px-5 py-6 sm:py-8 md:px-10 lg:px-14">
				{phaseLabel ? (
					<span className="bg-muted text-foreground/80 w-fit rounded-full px-3 py-1 font-mono text-[11px] font-medium uppercase tracking-wider">
						{phaseLabel}
					</span>
				) : null}
				<span className="font-mono text-[11px] font-medium uppercase tracking-wider opacity-60">
					Where this fits in the cycle
				</span>
			</div>
			{/* Reads left to right as a flow on desktop; on mobile it stacks in the
			    same order, so "This skill" stays sandwiched between its neighbours
			    rather than being reordered out of sequence. */}
			<div className="border-border bg-border grid grid-cols-1 gap-px border-t sm:grid-cols-3">
				<MiniFlowCell entry={prev} role="Previous" direction="prev" />
				<MiniFlowCell entry={current} role="This skill" isCurrent />
				<MiniFlowCell entry={next} role="Next" direction="next" />
			</div>
		</section>
	)
}

const CELL_PADDING = 'flex h-full flex-col gap-2 px-6 py-6 sm:px-8 sm:py-7'

/**
 * One step of the cycle. Neighbours are links carrying the signature hover
 * frame (DESIGN.md rule 13), the same treatment as the Up Next card, so the
 * two "where do I go next" surfaces behave identically. The current skill is
 * inert and marked with a filled dot rather than an arrow.
 */
function MiniFlowCell({
	entry,
	role,
	isCurrent = false,
	direction,
}: {
	entry: SkillEntry
	role: string
	isCurrent?: boolean
	/** Which way this step points, which decides the arrow and its side. */
	direction?: 'prev' | 'next'
}) {
	const Arrow = direction === 'prev' ? ArrowLeft : ArrowRight

	const roleRow = (
		<span className="flex items-center gap-1.5 font-mono text-[11px] font-medium uppercase tracking-wider opacity-60">
			{direction === 'prev' ? (
				<Arrow
					aria-hidden
					className="ease-out-quart size-3.5 shrink-0 transition-transform duration-300 group-hover/resource:-translate-x-1 motion-reduce:transform-none motion-reduce:transition-none"
				/>
			) : null}
			{role}
			{direction === 'next' ? (
				<Arrow
					aria-hidden
					className="ease-out-quart size-3.5 shrink-0 transition-transform duration-300 group-hover/resource:translate-x-1 motion-reduce:transform-none motion-reduce:transition-none"
				/>
			) : null}
		</span>
	)

	if (isCurrent) {
		return (
			<div aria-current="true" className={cn('bg-muted', CELL_PADDING)}>
				<span className="text-primary flex items-center gap-1.5 font-mono text-[11px] font-medium uppercase tracking-wider">
					<span aria-hidden className="bg-primary size-1.5 shrink-0 rounded-full" />
					{role}
				</span>
				<span className="text-balance text-base font-semibold leading-snug tracking-tight">
					{entry.title}
				</span>
			</div>
		)
	}

	return (
		<Link
			href={`/${entry.slug}`}
			className="group/resource bg-background focus-visible:ring-ring relative flex focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset"
		>
			<ResourceHoverFrame
				surfaceClassName="bg-background"
				className={CELL_PADDING}
			>
				{roleRow}
				<span className="text-balance text-base font-medium leading-snug tracking-tight">
					{entry.title}
				</span>
			</ResourceHoverFrame>
		</Link>
	)
}

type RelatedSkillPost = {
	id: string
	title: string
	slug: string
}

/**
 * Collects up to 2 related posts from the skill post's own non-phase (topic)
 * tags via `getCachedPostsByTag`. Excludes the skill post itself; dedupes
 * across tags. Returns [] gracefully when the post has no topic tags or none
 * match (empty state, never an error).
 */
async function getRelatedSkillPosts(post: Post): Promise<RelatedSkillPost[]> {
	const topicTagSlugs = (post.tags ?? [])
		.map((entry) => entry.tag)
		.filter((tag) => tag && !isSkillPhaseTag(tag))
		.map((tag) => tag.fields.slug)

	if (topicTagSlugs.length === 0) return []

	const seen = new Set<string>([post.id])
	const collected: RelatedSkillPost[] = []

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
			seen.add(related.id)
			collected.push({
				id: related.id,
				title: String(related.fields?.title ?? 'Untitled'),
				slug: relatedSlug,
			})
		}
	}

	return collected
}

/** Related-posts grid (up to 2), on-brand hairline cards. Renders nothing when empty. */
function SkillRelatedPosts({ posts }: { posts: RelatedSkillPost[] }) {
	if (posts.length === 0) return null

	const fillerCount = posts.length % 2 === 0 ? 0 : 1

	return (
		<section aria-label="Related posts" className="bg-background border-t">
			<div className="px-5 pb-6 pt-10 sm:px-8 sm:pt-12">
				<h2 className="text-balance text-2xl font-semibold leading-tight tracking-tight sm:text-3xl">
					Related reading
				</h2>
			</div>
			<div className="border-border bg-border grid grid-cols-1 gap-px border-t sm:grid-cols-2">
				{posts.map((item) => (
					<Link
						key={item.id}
						href={`/${item.slug}`}
						className="group bg-card hover:bg-muted focus-visible:ring-ring relative flex flex-col gap-4 px-5 py-8 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset sm:px-8 sm:py-10"
					>
						<h3 className="text-balance text-xl font-semibold leading-tight tracking-tight sm:text-2xl">
							{item.title}
						</h3>
						<span className="text-muted-foreground group-hover:text-foreground mt-auto inline-flex items-center gap-1.5 pt-2 text-sm font-medium transition-colors">
							Read more
							<ArrowRight className="ease-[cubic-bezier(0.22,1,0.36,1)] size-4 transition-transform duration-300 group-hover:translate-x-1 motion-reduce:transition-none motion-reduce:group-hover:translate-x-0" />
						</span>
					</Link>
				))}
				{Array.from({ length: fillerCount }).map((_, i) => (
					<div
						key={`filler-${i}`}
						aria-hidden
						className={cn('bg-background hidden sm:block')}
					/>
				))}
			</div>
		</section>
	)
}
