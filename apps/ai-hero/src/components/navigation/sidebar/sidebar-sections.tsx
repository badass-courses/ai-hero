import * as React from 'react'
import { type Post } from '@/lib/posts'
import { getCachedAllPosts, getCachedPostsByTag } from '@/lib/posts-query'
import { getSkillEntries } from '@/lib/skills-query'
import { getCachedTopicTag } from '@/lib/topics-query'
import { log } from '@/server/logger'

import {
	SidebarGroup,
	SidebarMenu,
	SidebarMenuItem,
	SidebarMenuSkeleton,
} from '@coursebuilder/ui'

import { SidebarNavLink, SidebarSection } from './sidebar-client'

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

async function WhatsNewSection({ limit = 3 }: { limit?: number }) {
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

		return (
			<SidebarSection title="What's New">
				<SidebarMenu>
					{postLinks(items)}
					<SidebarMenuItem>
						<SidebarNavLink href="/posts" muted>
							See all
						</SidebarNavLink>
					</SidebarMenuItem>
				</SidebarMenu>
			</SidebarSection>
		)
	} catch (error) {
		void log.error('hub-sidebar.whats-new.error', {
			error: error instanceof Error ? error.message : String(error),
		})
		return null
	}
}

/** `<WhatsNew />` — the most recent published, public posts + "See all". */
export function WhatsNew(props: { limit?: number }) {
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
				<SidebarMenu>
					{entries.map((entry) => (
						<SidebarMenuItem key={entry.id}>
							<SidebarNavLink href={`/${entry.slug}`}>
								{entry.title}
							</SidebarNavLink>
						</SidebarMenuItem>
					))}
					<SidebarMenuItem>
						<SidebarNavLink href="/skills" muted>
							All skills
						</SidebarNavLink>
					</SidebarMenuItem>
				</SidebarMenu>
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
					<SidebarMenu>
						{postLinks(posts)}
						{topicTag ? (
							<SidebarMenuItem>
								<SidebarNavLink href={`/topics/${topicTag.fields.slug}`} muted>
									All {title}
								</SidebarNavLink>
							</SidebarMenuItem>
						) : null}
					</SidebarMenu>
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
