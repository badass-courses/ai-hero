/**
 * Static structure for the hub sidebar's FALLBACK rendering.
 *
 * The primary sidebar is MDX-driven (CMS `hub-sidebar` page, compiled in
 * `hub-layout.tsx` with the scoped map in `sidebar/sidebar-mdx.tsx`); this
 * file backs `HubSidebarStaticContent`, which renders when that page is
 * missing or its MDX fails — a broken CMS edit must never kill nav. Keep
 * every link here resolving to a real page.
 *
 * Client-safe (no server imports) so the sidebar component can render the
 * structure directly. The dynamic "What's New" items are fetched server-side
 * in `hub-layout.tsx` and passed in as props.
 */

export type SidebarLink = {
	label: string
	href: string
}

export type SidebarTopicGroup = {
	label: string
	items: SidebarLink[]
}

/** Primary site sections. Mirrors the primary nav, plus the hub map itself. */
export const EXPLORE_LINKS: SidebarLink[] = [
	{ label: 'Map', href: '/learn' },
	{ label: 'Principles', href: '/principles' },
	{ label: 'Skills', href: '/skills' },
	{ label: 'Tools', href: '/tools' },
]

/** Flagship free resources. */
export const TENTPOLE_LINKS: SidebarLink[] = [
	{ label: 'LLM Fundamentals', href: '/llm-fundamentals' },
	{ label: 'AI Engineer Roadmap', href: '/ai-engineer-roadmap' },
	{ label: 'AI Coding Dictionary', href: '/ai-coding-dictionary' },
]

/**
 * Goal-oriented topic groups. PLACEHOLDER taxonomy — labels and grouping are
 * not final. Items point at existing pages so the collapsible tree and active
 * highlighting work today.
 */
export const TOPIC_GROUPS: SidebarTopicGroup[] = [
	{
		label: 'Understand the Basics',
		items: [
			{ label: 'LLM Fundamentals', href: '/llm-fundamentals' },
			{ label: 'AI Coding Dictionary', href: '/ai-coding-dictionary' },
		],
	},
	{
		label: 'Build AI Apps',
		items: [
			{ label: 'Vercel AI SDK Tutorial', href: '/vercel-ai-sdk-tutorial' },
			{
				label: 'Model Context Protocol',
				href: '/model-context-protocol-tutorial',
			},
		],
	},
	{
		label: 'Plan Your Path',
		items: [{ label: 'AI Engineer Roadmap', href: '/ai-engineer-roadmap' }],
	},
]

/** Where "See all" under What's New points. */
export const WHATS_NEW_SEE_ALL_HREF = '/posts'
