import 'server-only'

import { unstable_cache } from 'next/cache'
import { getPage } from '@/lib/pages-query'
import { type Post } from '@/lib/posts'
import { getCachedAllPosts, getCachedPostsByTag } from '@/lib/posts-query'
import { getSkillEntries } from '@/lib/skills-query'
import { getCachedTopicTag } from '@/lib/topics-query'
import { log } from '@/server/logger'

import { HUB_SIDEBAR_FALLBACK_MDX } from '@/components/navigation/hub-sidebar-fallback'

import {
	parseHubSidebarBlocks,
	type HubNavLink,
	type ParsedBlock,
} from './hub-sidebar-parse'

// Re-exported so every existing `@/lib/hub-sidebar-ia` import keeps working;
// imported above as well, because this module uses them itself.
export type { HubNavLink, ParsedBlock } from './hub-sidebar-parse'
export { parseHubSidebarBlocks } from './hub-sidebar-parse'

/**
 * Resolved, JSON-serializable hub-sidebar IA.
 *
 * This is the SINGLE-SOURCE bridge for surfaces that can't compile the sidebar
 * MDX themselves — namely the mobile menu, which renders in the global client
 * nav. The desktop sidebar renders the `hub-sidebar` MDX directly (server
 * components); here we take the blocks `hub-sidebar-parse.ts` reads out of the
 * SAME MDX body and resolve the dynamic ones (`<WhatsNew/>`, `<SkillsNav/>`,
 * `<TopicSection/>`) with the SAME cached queries, so both surfaces stay one
 * source. Consumed over tRPC (`navigation.getMobileNav`).
 */

/**
 * Two-tier structure mirroring the desktop sidebar (see Amy's mobile wireframe):
 * - `flat`     a non-collapsible category with links right under its label
 *              (Explore, Guides, What's New).
 * - `category` a bare category label with no links of its own — the collapsible
 *              groups that follow it sit visually beneath it (Topics).
 * - `group`    a collapsible group (a topic tag section, Skills, Meta).
 */
export type HubNavVariant = 'flat' | 'category' | 'group'

export type HubNavSection = {
	title: string
	variant: HubNavVariant
	links: HubNavLink[]
	/** Optional "see all" affordance (e.g. /posts, /topics/[slug]). */
	moreHref?: string
	moreLabel?: string
}

export type HubSidebarIa = { sections: HubNavSection[] }

/**
 * Cached body of the CMS `hub-sidebar` page (the MDX that defines the sidebar
 * menu). Only published pages count; `null` means "no curated page, use the
 * bundled default". Joined to the 'pages' tag so `updatePage` invalidates it.
 * Shared by `HubLayout` (desktop compile) and the IA resolver (mobile).
 */
export const getCachedHubSidebarBody = unstable_cache(
	async (): Promise<string | null> => {
		const page = await getPage('hub-sidebar')
		if (!page || page.fields.state !== 'published') return null
		const body = page.fields.body?.trim()
		return body ? body : null
	},
	['hub-sidebar-page-v1'],
	{ revalidate: 3600, tags: ['pages'] },
)

function isPublicPost(p: Post): boolean {
	return (
		p?.fields?.state === 'published' &&
		p?.fields?.visibility === 'public' &&
		Boolean(p?.fields?.slug) &&
		Boolean(p?.fields?.title)
	)
}

/**
 * Resolve parsed blocks into concrete sections, mirroring the server
 * components exactly: WhatsNew = latest public posts + "See all"; SkillsNav =
 * the skill cycle + "All skills"; TopicSection = curated links first, then the
 * tag feed deduped against them (over-fetched so the section still fills to
 * `limit`) + "All …". Empty dynamic sections are dropped, same as the JSX
 * returning null.
 */
async function resolveBlocks(blocks: ParsedBlock[]): Promise<HubNavSection[]> {
	const sections: HubNavSection[] = []

	for (const block of blocks) {
		if (block.kind === 'static') {
			// Heading (or legacy <SidebarSection>) with links → a flat category
			// like Explore / Guides: label + links, non-collapsible.
			if (block.links.length > 0) {
				sections.push({
					title: block.title,
					variant: 'flat',
					links: block.links,
				})
			}
			continue
		}

		if (block.kind === 'category') {
			// A bare `## Heading` (e.g. Topics) — just a label; the collapsible
			// groups that follow sit under it. Skip empties defensively.
			if (block.title) {
				sections.push({ title: block.title, variant: 'category', links: [] })
			}
			continue
		}

		if (block.kind === 'whatsNew') {
			const posts = ((await getCachedAllPosts()) as Post[])
				.filter(isPublicPost)
				.slice(0, 3)
			if (posts.length > 0) {
				sections.push({
					title: block.title,
					variant: 'flat',
					links: posts.map((p: Post) => ({
						label: p.fields.title,
						href: `/${p.fields.slug}`,
					})),
					moreHref: '/posts',
					moreLabel: 'See all',
				})
			}
			continue
		}

		if (block.kind === 'skillsNav') {
			const entries = await getSkillEntries()
			if (entries && entries.length > 0) {
				sections.push({
					title: block.title,
					variant: 'group',
					links: entries.map((e) => ({
						label: e.title,
						href: `/${e.slug}`,
					})),
					moreHref: '/skills',
					moreLabel: 'All skills',
				})
			}
			continue
		}

		// topic
		const limit = block.limit ?? 5
		const curatedHrefs = new Set(
			block.curated.map((l) => l.href.replace(/\/+$/, '')),
		)
		const topicTag = await getCachedTopicTag(block.tag)
		if (!topicTag && block.curated.length === 0) continue

		const title = topicTag?.fields.label ?? block.label ?? block.tag
		const tagPosts = topicTag
			? (
					await getCachedPostsByTag(block.tag, {
						limit: limit + curatedHrefs.size,
					})
				)
					.filter((p) => !curatedHrefs.has(`/${p.fields.slug}`))
					.slice(0, limit)
			: []

		sections.push({
			title,
			variant: 'group',
			links: [
				...block.curated,
				...tagPosts.map((p) => ({
					label: p.fields.title,
					href: `/${p.fields.slug}`,
				})),
			],
			...(topicTag && {
				moreHref: `/topics/${topicTag.fields.slug}`,
				moreLabel: `All ${title}`,
			}),
		})
	}

	return sections
}

const _getHubSidebarIa = unstable_cache(
	async (): Promise<HubSidebarIa> => {
		const body = (await getCachedHubSidebarBody()) ?? HUB_SIDEBAR_FALLBACK_MDX
		return { sections: await resolveBlocks(parseHubSidebarBlocks(body)) }
	},
	['hub-sidebar-ia-v3'],
	// Recompute when the page, its posts, tags, or the skills list change; the
	// result is identical for every visitor, so this is computed once and
	// shared — a mobile-menu open is a cache hit, not a fresh resolve.
	{ revalidate: 3600, tags: ['pages', 'posts', 'tags', 'lists'] },
)

/**
 * Static-only resolution of the bundled fallback MDX: headings with their
 * links, and each topic group's CURATED links. It touches no query, so it is
 * what remains resolvable when the database does not answer. The tag-fed
 * blocks (What's New, Skills, the tag feeds under each topic) are simply
 * absent — a shorter menu of links that all still work, rather than no menu.
 */
function resolveStaticFallback(): HubNavSection[] {
	const sections: HubNavSection[] = []
	for (const block of parseHubSidebarBlocks(HUB_SIDEBAR_FALLBACK_MDX)) {
		if (block.kind === 'static' && block.links.length > 0) {
			sections.push({ title: block.title, variant: 'flat', links: block.links })
		} else if (block.kind === 'category' && block.title) {
			sections.push({ title: block.title, variant: 'category', links: [] })
		} else if (block.kind === 'topic' && block.curated.length > 0) {
			sections.push({
				title: block.label ?? block.tag,
				variant: 'group',
				links: block.curated,
			})
		}
	}
	return sections
}

/**
 * Resolved hub-sidebar IA for client surfaces (mobile menu) via tRPC.
 *
 * Guarded, because nothing else is: `navigation.getMobileNav` is a
 * `publicProcedure` with no error boundary under it, and every query the
 * resolver runs (the page body, all posts, the skills list, each topic tag and
 * its feed) throws straight through on a database hiccup. That turned a blip
 * into a mobile menu that rendered nothing at all — no Explore, no Guides, on
 * a viewport where this IS the navigation.
 *
 * The catch is OUT here rather than inside `_getHubSidebarIa`: `unstable_cache`
 * never stores a thrown result, so the next open retries against a live
 * database instead of serving the degraded menu for the rest of the hour. Same
 * arrangement, and same reason, as `getCohortOfferSafe` in `nav-cta.ts`.
 */
export async function getHubSidebarIa(): Promise<HubSidebarIa> {
	try {
		return await _getHubSidebarIa()
	} catch (error) {
		await log
			.error('hub-sidebar-ia.resolve.failed', {
				error: error instanceof Error ? error.message : String(error),
			})
			.catch(() => undefined)
		return { sections: resolveStaticFallback() }
	}
}
