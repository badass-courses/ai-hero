import * as React from 'react'
import { unstable_cache } from 'next/cache'
import { filterSectionedResources } from '@/lib/list-sections'
import { getListWithSections } from '@/lib/lists-query'
import { type Post } from '@/lib/posts'
import { getCachedAllPosts, getCachedPostsByTag } from '@/lib/posts-query'
import { getModuleProgressForUser } from '@/lib/progress'
import { SKILLS_LIST_ID } from '@/lib/skills-content'
import { getSkillEntries } from '@/lib/skills-query'
import { getCachedTopicTag } from '@/lib/topics-query'
import { log } from '@/server/logger'

import {
	SidebarGroup,
	SidebarGroupLabel,
	SidebarMenu,
	SidebarMenuItem,
	SidebarMenuSkeleton,
} from '@coursebuilder/ui'

import {
	ListSectionLessons,
	SidebarNavLink,
	SidebarSection,
} from './sidebar-client'

/** Small-caps, non-collapsible category label — matches the MDX `## Heading`. */
const CATEGORY_LABEL_CLASS =
	'text-muted-foreground h-auto px-2 pb-1 pt-5 text-[11px] font-semibold uppercase tracking-wider'

/**
 * Server-driven sidebar sections registered in the hub-sidebar MDX components
 * map: `<WhatsNew />`, `<SkillsNav />`, `<TopicSection tag="…" />`. Each is a
 * Suspense-wrapped async server component over an existing cached query, and
 * each swallows its own errors (render nothing) so one broken section can
 * never take the whole sidebar down.
 */

/** Loading placeholder shaped like a sidebar section (label + 3 rows). */
function SectionSkeleton() {
	return (
		<SidebarGroup className="py-1" aria-hidden="true">
			<SidebarMenu>
				{Array.from({ length: 3 }).map((_, index) => (
					<SidebarMenuItem key={index}>
						<SidebarMenuSkeleton />
					</SidebarMenuItem>
				))}
			</SidebarMenu>
		</SidebarGroup>
	)
}

function postLinks(posts: Post[]) {
	return posts.map((post) => (
		<SidebarMenuItem key={post.id}>
			<SidebarNavLink href={`/${post.fields.slug}`}>
				{post.fields.title}
			</SidebarNavLink>
		</SidebarMenuItem>
	))
}

async function WhatsNewSection({
	title = "What's New",
	limit = 3,
}: {
	title?: string
	limit?: number
}) {
	try {
		const posts = await getCachedAllPosts()
		const items = (posts ?? [])
			.filter(
				(p: Post) =>
					p?.fields?.state === 'published' &&
					p?.fields?.visibility === 'public' &&
					Boolean(p?.fields?.slug) &&
					Boolean(p?.fields?.title),
			)
			.slice(0, limit)

		if (items.length === 0) return null

		// Self-contained non-collapsible category: renders its OWN small-caps
		// heading + list, so the whole group hides as a unit on post pages (the
		// `[post]` layout passes `hideWhatsNew`, which swaps this for a no-op).
		return (
			<>
				<SidebarGroupLabel className={CATEGORY_LABEL_CLASS}>
					{title}
				</SidebarGroupLabel>
				<SidebarGroup className="p-0">
					<SidebarMenu>
						{postLinks(items)}
						<SidebarMenuItem>
							<SidebarNavLink href="/posts" muted ariaLabel="See all posts">
								All
							</SidebarNavLink>
						</SidebarMenuItem>
					</SidebarMenu>
				</SidebarGroup>
			</>
		)
	} catch (error) {
		void log.error('hub-sidebar.whats-new.error', {
			error: error instanceof Error ? error.message : String(error),
		})
		return null
	}
}

/**
 * `<WhatsNew title="…" />` — the most recent published, public posts +
 * "See all". The group label comes from the MDX (default "What's New" is a
 * fallback only — the CMS page is the source of truth for labels).
 */
export function WhatsNew(props: { title?: string; limit?: number }) {
	return (
		<React.Suspense fallback={<SectionSkeleton />}>
			<WhatsNewSection {...props} />
		</React.Suspense>
	)
}

async function SkillsNavSection({ title = 'Skills' }: { title?: string }) {
	try {
		const entries = await getSkillEntries()
		if (!entries || entries.length === 0) return null

		return (
			<SidebarSection title={title}>
				<SidebarGroup className="p-0">
					<SidebarMenu>
						{entries.map((entry) => (
							<SidebarMenuItem key={entry.id}>
								<SidebarNavLink href={`/${entry.slug}`}>
									{entry.title}
								</SidebarNavLink>
							</SidebarMenuItem>
						))}
						<SidebarMenuItem>
							<SidebarNavLink href="/skills" muted ariaLabel="All skills">
								All
							</SidebarNavLink>
						</SidebarMenuItem>
					</SidebarMenu>
				</SidebarGroup>
			</SidebarSection>
		)
	} catch (error) {
		void log.error('hub-sidebar.skills-nav.error', {
			error: error instanceof Error ? error.message : String(error),
		})
		return null
	}
}

/** `<SkillsNav />` — the skill cycle (list-ordered skill posts) + "All skills". */
export function SkillsNav(props: { title?: string }) {
	return (
		<React.Suspense fallback={<SectionSkeleton />}>
			<SkillsNavSection {...props} />
		</React.Suspense>
	)
}

type SidebarSkillGroup = {
	id: string
	/** Section title, or null for a run of loose (unsectioned) skills. */
	title: string | null
	items: { id: string; slug: string; title: string }[]
}

/**
 * The skills list's displayable rows for the sidebar Skills entry — sections
 * PRESERVED as titled groups (they render as sub-headings in the accordion),
 * unlisted/unpublished dropped (same visibility rules as the /skills page via
 * `filterSectionedResources`). Serializable, cached under the shared
 * list/post tags. Deliberately NOT `getSkillEntries()`: the sidebar mirrors
 * the LIST (membership by list, postType-independent), so it can't go blank
 * if postType churns (as it did in the 2026-07-06 incident). Also returns
 * the list's slug so the section can claim list-precedence auto-open.
 */
const getCachedSkillsSidebarGroups = unstable_cache(
	async (): Promise<{ listSlug?: string; groups: SidebarSkillGroup[] }> => {
		const list = await getListWithSections(SKILLS_LIST_ID)
		const rows = filterSectionedResources(list?.resources)
		const toItem = (resource: any) => {
			const slug = resource?.fields?.slug
			const title = resource?.fields?.title
			return typeof slug === 'string' && typeof title === 'string'
				? { id: resource.id as string, slug, title }
				: null
		}
		const groups: SidebarSkillGroup[] = []
		let looseRun: SidebarSkillGroup | null = null
		for (const row of rows) {
			const resource: any = row?.resource
			if (!resource) continue
			if (resource.type === 'section') {
				const items = (resource.resources ?? [])
					.map((child: any) => toItem(child?.resource))
					.filter(Boolean) as SidebarSkillGroup['items']
				if (items.length === 0) continue
				looseRun = null
				groups.push({
					id: resource.id as string,
					title:
						typeof resource.fields?.title === 'string'
							? resource.fields.title
							: null,
					items,
				})
				continue
			}
			const item = toItem(resource)
			if (!item) continue
			if (!looseRun) {
				looseRun = { id: `loose-${groups.length}`, title: null, items: [] }
				groups.push(looseRun)
			}
			looseRun.items.push(item)
		}
		return { listSlug: list?.fields?.slug, groups }
	},
	['sidebar-skills-groups-v1'],
	{ revalidate: 3600, tags: ['lists', 'posts'] },
)

async function SkillsEntrySection({
	href,
	label,
}: {
	href: string
	label: React.ReactNode
}) {
	try {
		const { listSlug, groups } = await getCachedSkillsSidebarGroups()
		const itemHrefs = groups.flatMap((group) =>
			group.items.map((item) => `/${item.slug}`),
		)
		if (itemHrefs.length === 0) {
			return <SidebarNavLink href={href}>{label}</SidebarNavLink>
		}
		// Per-user, per-request (NOT in the shared cache): the ✓ marks must show
		// on every hub page, not just inside the [post] layout's ProgressProvider.
		const progress = await getModuleProgressForUser(SKILLS_LIST_ID)
		return (
			<SidebarSection
				title={label}
				iconHref={href}
				ownListSlug={listSlug}
				extraHrefs={[href, ...itemHrefs]}
			>
				<ListSectionLessons
					groups={groups}
					overviewHref={href}
					completedLessons={progress?.completedLessons}
				/>
			</SidebarSection>
		)
	} catch (error) {
		void log.error('hub-sidebar.skills-entry.error', {
			error: error instanceof Error ? error.message : String(error),
		})
		return <SidebarNavLink href={href}>{label}</SidebarNavLink>
	}
}

/**
 * The Explore "Skills" entry: the SAME `SidebarSection` accordion as the
 * topic groups (icon + right-side chevron), disclosing the skill list —
 * section sub-headings, Overview row, numbered skills — on ANY hub page.
 * Rendered by the MDX map whenever the sidebar body links `/skills` — the
 * body keeps its plain `[Skills](/skills)` line (which also keeps
 * `HubLayout`'s pinned-block gate satisfied). Falls back to the plain link
 * while loading or on error.
 */
export function SkillsEntry(props: { href: string; label: React.ReactNode }) {
	return (
		<React.Suspense
			fallback={<SidebarNavLink href={props.href}>{props.label}</SidebarNavLink>}
		>
			<SkillsEntrySection {...props} />
		</React.Suspense>
	)
}

/**
 * Collect every `href` in a curated-children element tree (the sidebar MDX map
 * puts hrefs on `a`/`SidebarLink` → `SidebarNavLink` elements). Used to dedupe
 * the tag-driven post list against the curated links above it.
 */
function collectHrefs(node: React.ReactNode, into: Set<string>): Set<string> {
	if (Array.isArray(node)) {
		for (const child of node) collectHrefs(child, into)
	} else if (React.isValidElement(node)) {
		const props = node.props as { href?: unknown; children?: React.ReactNode }
		if (typeof props.href === 'string') {
			into.add(props.href.replace(/\/+$/, ''))
		}
		if (props.children) collectHrefs(props.children, into)
	}
	return into
}

async function TopicSectionInner({
	tag,
	label,
	limit = 5,
	children,
}: {
	tag: string
	label?: string
	limit?: number
	children?: React.ReactNode
}) {
	try {
		const curatedHrefs = collectHrefs(children, new Set<string>())
		const topicTag = await getCachedTopicTag(tag)
		// Over-fetch by the curated count so dedupe can't leave the section
		// short of `limit`; curated links stay the pinned, ordered picks and
		// the tag feed is the fresh tail.
		const posts = topicTag
			? (await getCachedPostsByTag(tag, { limit: limit + curatedHrefs.size }))
					.filter((post) => !curatedHrefs.has(`/${post.fields.slug}`))
					.slice(0, limit)
			: []
		const title = topicTag?.fields.label ?? label

		// No tag AND no curated fallback links → nothing sensible to render.
		if (!title) return null
		if (!topicTag && !children) {
			void log.warn('hub-sidebar.topic-section.missing-tag', { tag })
			return null
		}

		return (
			<SidebarSection title={title}>
				{children}
				{posts.length > 0 || topicTag ? (
					// Wrapped in a SidebarGroup so the server posts + "All" sit at the
					// same indent as curated markdown children (which the MDX `- list`
					// mapping nests in a SidebarGroup). Without this the "All" link is
					// 8px shallower than its siblings — the topic-group inconsistency.
					<SidebarGroup className="p-0">
						<SidebarMenu>
							{postLinks(posts)}
							{topicTag ? (
								<SidebarMenuItem>
									<SidebarNavLink
										href={`/topics/${topicTag.fields.slug}`}
										muted
										ariaLabel={`All ${title}`}
									>
										All
									</SidebarNavLink>
								</SidebarMenuItem>
							) : null}
						</SidebarMenu>
					</SidebarGroup>
				) : null}
			</SidebarSection>
		)
	} catch (error) {
		void log.error('hub-sidebar.topic-section.error', {
			tag,
			error: error instanceof Error ? error.message : String(error),
		})
		return null
	}
}

/**
 * `<TopicSection tag="…" label="…" limit={5} />` — a collapsible topic group:
 * label from the CMS tag (`label` prop is the fallback while the tag doesn't
 * exist yet), top N tagged posts, and an "All →" link to `/topics/[slug]`.
 * Curated markdown links may be nested as children; they render above the
 * tag-driven posts, and any post already curated is skipped in the tag feed
 * (deduped by href, over-fetched so the section still fills to `limit`).
 */
export function TopicSection(props: {
	tag: string
	label?: string
	limit?: number
	children?: React.ReactNode
}) {
	return (
		<React.Suspense fallback={<SectionSkeleton />}>
			<TopicSectionInner {...props} />
		</React.Suspense>
	)
}
