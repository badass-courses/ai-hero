/**
 * SkillPage — the `postType: 'skill'` template rendered by the `[post]`
 * catch-all (spec w2-skills-pages §5). Skill URLs stay flat (`/skills-grill-me`);
 * this template is selected by postType, not by a dedicated route.
 *
 * Section order (wireframe / spec §5):
 *   breadcrumb "Skills › {name}" → header (title + tagline) → phase badge →
 *   GitHub-synced body (compiled exactly as PostBody does) → install block →
 *   free-lesson CTA → newsletter → workflow mini-flow (prev→current→next with
 *   cycle wraparound) → related posts.
 *
 * All skill data is CMS-owned via `getSkillEntries()` (list order + phase tags
 * + synced taglines). `getSkillEntries()` returns `[]` until `postType: 'skill'`
 * is set on prod skill posts (a post-deploy content op), so every consumer here
 * degrades gracefully when the current post has no matching entry: no phase
 * badge, no mini-flow, header/body/CTAs still render.
 *
 * The HubLayout sidebar shell is provided by `[post]/layout.tsx` (standalone
 * post branch) — this component renders only the page `<main>`, matching how
 * `PostPage` returns its `<main>` directly.
 */

import * as React from 'react'
import Link from 'next/link'
import { InstallCommand } from '@/app/(content)/skills/_components/install-command'
import { Breadcrumbs } from '@/components/breadcrumbs'
import { Contributor } from '@/components/contributor'
import { PrimaryNewsletterCta } from '@/components/primary-newsletter-cta'
import { ContentReadTracker } from '@/components/content-read-tracker'
import { Share } from '@/components/share'
import { type Post } from '@/lib/posts'
import { getCachedPostsByTag } from '@/lib/posts-query'
import { SKILLS_FREE_LESSON, SKILLS_HERO } from '@/lib/skills-content'
import { getSkillEntries, isSkillPhaseTag, type SkillEntry } from '@/lib/skills-query'
import {
	ArticleStructuredData,
	BreadcrumbStructuredData,
} from '@/lib/structured-data'
import { compileMDX } from '@/utils/compile-mdx'
import { ArrowRight } from 'lucide-react'

import { cn } from '@coursebuilder/utils/cn'

/** Strip a leading `skills-` prefix so the slash-command hint reads `/grill-me`. */
function invocationName(slug: string): string {
	return slug.replace(/^skills-/, '')
}

export async function SkillPage({ post }: { post: Post }) {
	const slug = String(post.fields?.slug ?? '')
	const title = String(post.fields?.title ?? 'Skill')

	// CMS-owned skill data. Empty until the postType content op runs; when this
	// post isn't (yet) a list member, `entry` is undefined and phase/mini-flow
	// simply don't render.
	const entries = await getSkillEntries()
	const entry = entries.find((e) => e.slug === slug)

	const phaseLabel = entry?.phase?.label ?? null
	const tagline =
		entry?.tagline ||
		(typeof post.fields?.description === 'string'
			? post.fields.description
			: '')

	const neighbors = getSkillNeighbors(entries, slug)

	// Related posts: the skill post's own non-phase (topic) tags, capped at 2.
	const relatedPosts = await getRelatedSkillPosts(post)

	return (
		<main className="bg-card w-full dark:bg-transparent">
			<ArticleStructuredData
				resource={post}
				canonicalPath={`/${slug}`}
				section="AI Skills"
			/>
			<BreadcrumbStructuredData
				items={[
					{ name: 'Home', path: '/' },
					{ name: 'AI Skills', path: '/skills' },
					{ name: title, path: `/${slug}` },
				]}
			/>
			<ContentReadTracker
				contentId={post.id}
				contentType="post"
				contentSlug={slug}
			/>

			<article className="relative flex h-full flex-col">
				{/* Header */}
				<div className="flex w-full flex-col gap-5 px-5 pb-6 pt-6 sm:pt-10 md:px-10 lg:px-14">
					<Breadcrumbs
						items={[
							{ label: 'Skills', href: '/skills' },
							{ label: title },
						]}
					/>
					{phaseLabel ? (
						<span className="bg-muted text-foreground/80 w-fit rounded-full px-3 py-1 font-mono text-[11px] font-medium uppercase tracking-wider">
							{phaseLabel}
						</span>
					) : null}
					<h1 className="text-3xl font-semibold leading-tight tracking-tight sm:text-4xl lg:text-5xl dark:text-white">
						{title}
					</h1>
					{tagline ? (
						<p className="text-muted-foreground max-w-2xl text-lg leading-relaxed text-balance">
							{tagline}
						</p>
					) : null}
					<Contributor className="text-foreground mt-1 flex text-sm font-medium [&_img]:w-8" />
				</div>

				{/* What it does / why — GitHub-synced body */}
				<SkillBody body={post.fields?.body} />

				{/* Install */}
				<SkillInstallBlock slug={slug} />

				{/* Free-lesson CTA */}
				<FreeLessonCta />

				{/* Newsletter */}
				<PrimaryNewsletterCta
					isHiddenForSubscribers
					className="border-t pt-14 sm:pb-5 sm:pt-20"
					trackProps={{
						event: 'subscribed',
						params: {
							post: slug,
							location: 'skill-page',
						},
					}}
				/>

				{/* Workflow position mini-flow */}
				<SkillMiniFlow neighbors={neighbors} />

				{/* Related posts */}
				<SkillRelatedPosts posts={relatedPosts} />

				{/* Share */}
				<div className="mx-auto mt-16 flex w-full flex-wrap items-center justify-center gap-5 border-t pl-5">
					<strong className="text-lg font-semibold">Share</strong>
					<Share
						className="inline-flex rounded-none border-y-0"
						title={title}
					/>
				</div>
			</article>
		</main>
	)
}

/**
 * Compiles the GitHub-synced MDX body exactly as the changelog / PostBody paths
 * do (`compileMDX(body, {}, {})`). Returns null for an empty body.
 */
async function SkillBody({ body }: { body?: unknown }) {
	if (typeof body !== 'string' || body.length === 0) {
		return null
	}

	const { content } = await compileMDX(body, {}, {})

	return (
		<div className="px-5 md:px-10 lg:px-14">
			<article className="prose prose-hr:border-border dark:prose-invert prose-a:text-primary sm:prose-lg lg:prose-lg prose-p:max-w-4xl prose-headings:max-w-4xl prose-ul:max-w-4xl prose-table:max-w-4xl prose-pre:max-w-4xl mt-10 max-w-none">
				{content}
			</article>
		</div>
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
			<div className="mx-auto flex w-full max-w-4xl flex-col gap-4 px-5 py-12 md:px-10 lg:px-14">
				<h2 className="text-2xl font-medium leading-tight tracking-tight sm:text-3xl">
					{SKILLS_FREE_LESSON.label}
				</h2>
				{SKILLS_FREE_LESSON.description ? (
					<p className="text-muted-foreground max-w-2xl text-base leading-relaxed">
						{SKILLS_FREE_LESSON.description}
					</p>
				) : null}
				<Link
					href={SKILLS_FREE_LESSON.href}
					className="group focus-visible:ring-ring inline-flex w-fit items-center gap-2 text-base font-medium underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
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
function SkillMiniFlow({ neighbors }: { neighbors: SkillNeighbors }) {
	if (!neighbors) return null

	const { prev, current, next } = neighbors

	return (
		<section aria-label="Skill workflow position" className="border-t">
			<div className="px-5 py-6 sm:py-8 md:px-10 lg:px-14">
				<span className="font-mono text-[11px] font-medium uppercase tracking-wider opacity-60">
					Where this fits in the cycle
				</span>
			</div>
			<div className="border-border bg-border grid grid-cols-1 gap-px border-t sm:grid-cols-3">
				<MiniFlowCell entry={prev} role="Previous" />
				<MiniFlowCell entry={current} role="This skill" isCurrent />
				<MiniFlowCell entry={next} role="Next" />
			</div>
		</section>
	)
}

function MiniFlowCell({
	entry,
	role,
	isCurrent = false,
}: {
	entry: SkillEntry
	role: string
	isCurrent?: boolean
}) {
	const label = (
		<>
			<span className="font-mono text-[11px] font-medium uppercase tracking-wider opacity-60">
				{role}
			</span>
			<span className="mt-1 block text-base font-medium leading-snug tracking-tight">
				{entry.title}
			</span>
		</>
	)

	if (isCurrent) {
		return (
			<div
				aria-current="true"
				className="bg-muted flex flex-col px-6 py-6 sm:px-8"
			>
				{label}
			</div>
		)
	}

	return (
		<Link
			href={`/${entry.slug}`}
			className="group bg-background hover:bg-muted focus-visible:ring-ring flex flex-col px-6 py-6 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset sm:px-8"
		>
			{label}
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
