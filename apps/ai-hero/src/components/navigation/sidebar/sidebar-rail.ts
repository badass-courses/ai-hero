import {
	parseHubSidebarBlocks,
	type HubNavLink,
} from '@/lib/hub-sidebar-parse'

/**
 * The narrow rail cannot carry every article in the full sidebar. These are
 * the stable top-level destinations that have a meaningful icon treatment.
 * Their SECTION and ORDER still come from the authored sidebar body.
 */
const RAIL_DESTINATIONS = new Set([
	'/learn',
	'/principles',
	'/skills',
	'/open-source',
	'/llm-fundamentals',
	'/ai-engineer-roadmap',
	'/ai-coding-dictionary',
	'/posts',
])

export type CollapsedSidebarSection = {
	title: string
	links: HubNavLink[]
	/**
	 * A category such as Topics has no single destination. In the rail it gets
	 * one disclosure control that opens the full sidebar instead of inventing a
	 * route or promoting one topic above its siblings.
	 */
	expandOnly?: boolean
}

function normalizeHref(href: string): string {
	const trimmed = href.split(/[?#]/)[0]?.replace(/\/+$/, '') || ''
	return trimmed === '' ? '/' : trimmed.toLowerCase()
}

/**
 * Build the compact rail from the same ordered MDX blocks as the expanded
 * sidebar. Collapsing may reduce how much content is visible, but it must never
 * regroup or reorder the destinations that remain.
 */
export function buildCollapsedSidebarSections(
	body: string,
): CollapsedSidebarSection[] {
	const sections: CollapsedSidebarSection[] = []
	const seen = new Set<string>()

	for (const block of parseHubSidebarBlocks(body)) {
		if (block.kind === 'static') {
			const links = block.links.filter((link) => {
				const href = normalizeHref(link.href)
				if (!RAIL_DESTINATIONS.has(href) || seen.has(href)) return false
				seen.add(href)
				return true
			})

			if (links.length > 0) {
				sections.push({ title: block.title, links })
			}
			continue
		}

		if (block.kind === 'whatsNew') {
			if (!seen.has('/posts')) {
				seen.add('/posts')
				sections.push({
					title: block.title,
					links: [{ label: 'All posts', href: '/posts' }],
				})
			}
			continue
		}

		if (block.kind === 'category') {
			sections.push({
				title: block.title,
				links: [],
				expandOnly: true,
			})
		}
	}

	return sections
}
