import { createHash } from 'node:crypto'
import * as React from 'react'
import { LRUCache } from 'lru-cache'
import { compileMDX } from 'next-mdx-remote/rsc'

import {
	SidebarGroup,
	SidebarGroupLabel,
	SidebarMenu,
	SidebarMenuItem,
	SidebarSeparator,
} from '@coursebuilder/ui'

import { SidebarNavLink, SidebarSection } from './sidebar-client'
import { SIDEBAR_LABEL_CLASS } from './sidebar-indent'
import {
	SkillsEntry,
	SkillsNav,
	TopicSection,
	WhatsNew,
} from './sidebar-sections'

/**
 * Sidebar-scoped MDX pipeline for the CMS `hub-sidebar` page. Deliberately a
 * SEPARATE, tiny components map — NOT the global map in
 * `src/utils/compile-mdx.tsx` (no CodeHike, no page-builder blocks): the
 * sidebar vocabulary is markdown structure + three registered server
 * components. See lat.md/decisions.md "MDX-driven sidebar".
 *
 * Markdown mapping contract for authors:
 * - `## Heading`            → non-collapsible group label
 * - `<SidebarSection title> → collapsible group (contents nest inside)
 * - `- [Label](/href)` list → sidebar menu of links (active state + tracking)
 * - `<WhatsNew />` / `<SkillsNav />` / `<TopicSection tag="…" />`
 *                           → server-driven sections (Suspense-wrapped)
 * - `---`                   → separator
 */
const sidebarMdxComponents = {
	// Headings are the top tier: small-caps category labels that "group groups"
	// (Explore, Guides, What's New, Topics). Non-collapsible. The collapsible
	// topic groups (bold, `SidebarSection`) nest under the Topics heading.
	h1: (props: { children?: React.ReactNode }) => (
		<SidebarGroupLabel className={SIDEBAR_LABEL_CLASS}>
			{props.children}
		</SidebarGroupLabel>
	),
	h2: (props: { children?: React.ReactNode }) => (
		<SidebarGroupLabel className={SIDEBAR_LABEL_CLASS}>
			{props.children}
		</SidebarGroupLabel>
	),
	h3: (props: { children?: React.ReactNode }) => (
		<SidebarGroupLabel className={SIDEBAR_LABEL_CLASS}>
			{props.children}
		</SidebarGroupLabel>
	),
	ul: (props: { children?: React.ReactNode }) => (
		<SidebarGroup className="p-0">
			{/* gap-px, the prototype's `.ah-sidebar__group`: rows sit a hairline
			    apart, so the group reads as one block and the hover/active fills
			    still separate. */}
			<SidebarMenu className="gap-px">{props.children}</SidebarMenu>
		</SidebarGroup>
	),
	li: (props: { children?: React.ReactNode }) => (
		<SidebarMenuItem>{props.children}</SidebarMenuItem>
	),
	a: (props: { href?: string; children?: React.ReactNode }) =>
		// The `/skills` link is a disclosure entry: label navigates, a right-side
		// chevron expands the skill list in place on ANY hub page. Intercepted
		// here so the CMS body keeps its plain `[Skills](/skills)` line (which
		// HubLayout's pinned-series gate also reads).
		props.href === '/skills' ? (
			<SkillsEntry href={props.href} label={props.children} />
		) : (
			<SidebarNavLink href={props.href ?? '#'}>{props.children}</SidebarNavLink>
		),
	// Stray prose renders as quiet fine print rather than breaking layout.
	p: (props: { children?: React.ReactNode }) => (
		<p className="text-muted-foreground px-2.5 py-1 text-xs leading-relaxed">
			{props.children}
		</p>
	),
	hr: () => <SidebarSeparator className="mx-2.5 my-3" />,
	SidebarSection,
	SidebarLink: (props: { href?: string; children?: React.ReactNode }) => (
		<SidebarMenuItem>
			<SidebarNavLink href={props.href ?? '#'}>{props.children}</SidebarNavLink>
		</SidebarMenuItem>
	),
	WhatsNew,
	SkillsNav,
	TopicSection,
}

// Module-level like `sidebarMdxComponents` itself: the `hideWhatsNew` variant
// is one of exactly two stable maps, so a cached compile never captures a
// per-call closure.
const sidebarMdxComponentsWithoutWhatsNew = {
	...sidebarMdxComponents,
	WhatsNew: () => null,
}

/**
 * Compiled-sidebar cache, shared across requests for the lifetime of the
 * server instance. The sidebar body compiles on EVERY hub page render (twice,
 * when `HubLayout` splits it around the Topics heading), and the output is a
 * pure function of (source, hideWhatsNew) — the key. A CMS edit to the
 * sidebar page is a new source, hence a new key; nothing to revalidate.
 * The article pipeline in `src/utils/compile-mdx.tsx` caches the same way.
 */
const compiledSidebarCache = new LRUCache<string, Promise<React.ReactNode>>({
	max: 20,
})

/**
 * Compile the hub-sidebar page body with the sidebar-scoped map. Throws on
 * malformed MDX — the caller (`HubLayout`) catches and falls back to the
 * static sidebar; a broken CMS edit must never kill nav.
 *
 * `hideWhatsNew` swaps `<WhatsNew />` for a no-op so the whole "What's New"
 * category (its self-rendered heading + list) disappears on standalone post
 * pages, where the reader is already deep in the content.
 */
export async function compileHubSidebarMdx(
	source: string,
	{ hideWhatsNew = false }: { hideWhatsNew?: boolean } = {},
): Promise<React.ReactNode> {
	const key = `${hideWhatsNew ? 'no-whats-new' : 'full'}:${createHash('sha256')
		.update(source)
		.digest('base64')}`
	const cached = compiledSidebarCache.get(key)
	if (cached) return cached

	const pending = compileMDX({
		source,
		components: hideWhatsNew
			? sidebarMdxComponentsWithoutWhatsNew
			: sidebarMdxComponents,
		options: { parseFrontmatter: true },
	}).then(({ content }) => content)
	// The promise is cached so concurrent renders share one compile; a
	// rejection evicts itself and still throws to the caller, whose fallback
	// layering (static body, error boundary) is the error path.
	compiledSidebarCache.set(key, pending)
	pending.catch(() => compiledSidebarCache.delete(key))
	return pending
}
