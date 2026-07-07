import * as React from 'react'
import { compileMDX } from 'next-mdx-remote/rsc'

import {
	SidebarGroup,
	SidebarGroupLabel,
	SidebarMenu,
	SidebarMenuItem,
	SidebarSeparator,
} from '@coursebuilder/ui'

import { SidebarNavLink, SidebarSection } from './sidebar-client'
import { SkillsNav, TopicSection, WhatsNew } from './sidebar-sections'

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
		<SidebarGroupLabel className="text-muted-foreground h-auto px-2 pb-1 pt-5 text-[11px] font-semibold uppercase tracking-wider">
			{props.children}
		</SidebarGroupLabel>
	),
	h2: (props: { children?: React.ReactNode }) => (
		<SidebarGroupLabel className="text-muted-foreground h-auto px-2 pb-1 pt-5 text-[11px] font-semibold uppercase tracking-wider">
			{props.children}
		</SidebarGroupLabel>
	),
	h3: (props: { children?: React.ReactNode }) => (
		<SidebarGroupLabel className="text-muted-foreground h-auto px-2 pb-1 pt-5 text-[11px] font-semibold uppercase tracking-wider">
			{props.children}
		</SidebarGroupLabel>
	),
	ul: (props: { children?: React.ReactNode }) => (
		<SidebarGroup className="p-0">
			<SidebarMenu className='gap-0'>{props.children}</SidebarMenu>
		</SidebarGroup>
	),
	li: (props: { children?: React.ReactNode }) => (
		<SidebarMenuItem>{props.children}</SidebarMenuItem>
	),
	a: (props: { href?: string; children?: React.ReactNode }) => (
		<SidebarNavLink href={props.href ?? '#'}>{props.children}</SidebarNavLink>
	),
	// Stray prose renders as quiet fine print rather than breaking layout.
	p: (props: { children?: React.ReactNode }) => (
		<p className="text-muted-foreground px-4 py-1 text-xs leading-relaxed">
			{props.children}
		</p>
	),
	hr: () => <SidebarSeparator className="my-2" />,
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
	const components = hideWhatsNew
		? { ...sidebarMdxComponents, WhatsNew: () => null }
		: sidebarMdxComponents
	const { content } = await compileMDX({
		source,
		components,
		options: { parseFrontmatter: true },
	})
	return content
}
