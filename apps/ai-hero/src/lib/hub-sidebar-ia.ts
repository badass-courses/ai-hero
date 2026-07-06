import 'server-only'

import { unstable_cache } from 'next/cache'
import { getPage } from '@/lib/pages-query'
import { type Post } from '@/lib/posts'
import { getCachedAllPosts, getCachedPostsByTag } from '@/lib/posts-query'
import { getSkillEntries } from '@/lib/skills-query'
import { getCachedTopicTag } from '@/lib/topics-query'

import { HUB_SIDEBAR_FALLBACK_MDX } from '@/components/navigation/hub-sidebar-fallback'

/**
 * Resolved, JSON-serializable hub-sidebar IA.
 *
 * This is the SINGLE-SOURCE bridge for surfaces that can't compile the sidebar
 * MDX themselves — namely the mobile menu, which renders in the global client
 * nav. The desktop sidebar renders the `hub-sidebar` MDX directly (server
 * components); here we parse the SAME MDX body into a flat section/link tree
 * and resolve its dynamic sections (`<WhatsNew/>`, `<SkillsNav/>`,
 * `<TopicSection/>`) with the SAME cached queries, so both surfaces stay one
 * source. Consumed over tRPC (`navigation.getMobileNav`).
 */
export type HubNavLink = { label: string; href: string }

export type HubNavSection = {
	title: string
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

type ParsedBlock =
	| { kind: 'static'; title: string; links: HubNavLink[] }
	| { kind: 'whatsNew'; title: string }
	| { kind: 'skillsNav'; title: string }
	| {
			kind: 'topic'
			tag: string
			label?: string
			limit?: number
			curated: HubNavLink[]
	  }

function stringAttr(attrs: string, name: string): string | undefined {
	const m = attrs.match(new RegExp(`${name}="([^"]*)"`))
	return m ? m[1] : undefined
}

function numberAttr(attrs: string, name: string): number | undefined {
	const m = attrs.match(new RegExp(`${name}=\\{(\\d+)\\}`))
	return m ? Number(m[1]) : undefined
}

/** Markdown (`- [L](/h)`) and `<SidebarLink href>` links inside a section. */
function parseLinks(inner: string): HubNavLink[] {
	const links: HubNavLink[] = []
	const md = /-\s*\[([^\]]+)\]\(([^)]+)\)/g
	let m: RegExpExecArray | null
	while ((m = md.exec(inner))) {
		links.push({ label: m[1]!.trim(), href: m[2]!.trim() })
	}
	const jsx = /<SidebarLink\s+href="([^"]+)"\s*>([\s\S]*?)<\/SidebarLink>/g
	while ((m = jsx.exec(inner))) {
		links.push({ label: m[2]!.trim(), href: m[1]!.trim() })
	}
	return links
}

/**
 * Parse the hub-sidebar MDX body into ordered blocks. The vocabulary is the
 * small, controlled set the sidebar map registers (SidebarSection, WhatsNew,
 * SkillsNav, TopicSection — none of which nest), so a match-and-order pass is
 * sufficient and stays in lockstep with the MDX. Anything unrecognized is
 * simply skipped — never a throw (nav must survive a weird edit).
 */
export function parseHubSidebarBlocks(rawBody: string): ParsedBlock[] {
	// Strip MDX comments first — the CMS page carries an authoring comment whose
	// examples (`<SidebarSection title="…">`, `- [Label](/href)`) would
	// otherwise be parsed as real blocks. The MDX compiler ignores them; so do
	// we.
	const body = rawBody.replace(/\{\/\*[\s\S]*?\*\/\}/g, '')

	const found: {
		index: number
		kind: ParsedBlock['kind']
		attrs: string
		inner: string
	}[] = []

	const scan = (
		re: RegExp,
		kind: ParsedBlock['kind'],
		hasInner: boolean,
	) => {
		let m: RegExpExecArray | null
		while ((m = re.exec(body))) {
			found.push({
				index: m.index,
				kind,
				attrs: m[1] ?? '',
				inner: hasInner ? (m[2] ?? '') : '',
			})
		}
	}

	scan(/<SidebarSection\s+([^>]*?)>([\s\S]*?)<\/SidebarSection>/g, 'static', true)
	scan(/<TopicSection\s+([^>]*?)>([\s\S]*?)<\/TopicSection>/g, 'topic', true)
	scan(/<WhatsNew\b([^>]*?)\/>/g, 'whatsNew', false)
	scan(/<SkillsNav\b([^>]*?)\/>/g, 'skillsNav', false)

	found.sort((a, b) => a.index - b.index)

	return found.map((f): ParsedBlock => {
		switch (f.kind) {
			case 'static':
				return {
					kind: 'static',
					title: stringAttr(f.attrs, 'title') ?? '',
					links: parseLinks(f.inner),
				}
			case 'topic':
				return {
					kind: 'topic',
					tag: stringAttr(f.attrs, 'tag') ?? '',
					label: stringAttr(f.attrs, 'label'),
					limit: numberAttr(f.attrs, 'limit'),
					curated: parseLinks(f.inner),
				}
			case 'whatsNew':
				return {
					kind: 'whatsNew',
					title: stringAttr(f.attrs, 'title') ?? "What's New",
				}
			case 'skillsNav':
				return {
					kind: 'skillsNav',
					title: stringAttr(f.attrs, 'title') ?? 'Skills',
				}
		}
	})
}

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
			if (block.links.length > 0) {
				sections.push({ title: block.title, links: block.links })
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
			? (await getCachedPostsByTag(block.tag, { limit: limit + curatedHrefs.size }))
					.filter((p) => !curatedHrefs.has(`/${p.fields.slug}`))
					.slice(0, limit)
			: []

		sections.push({
			title,
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
	['hub-sidebar-ia-v2'],
	// Recompute when the page, its posts, tags, or the skills list change; the
	// result is identical for every visitor, so this is computed once and
	// shared — a mobile-menu open is a cache hit, not a fresh resolve.
	{ revalidate: 3600, tags: ['pages', 'posts', 'tags', 'lists'] },
)

/** Resolved hub-sidebar IA for client surfaces (mobile menu) via tRPC. */
export async function getHubSidebarIa(): Promise<HubSidebarIa> {
	return _getHubSidebarIa()
}
