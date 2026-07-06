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
	// Headings all render as group labels — the sidebar has no heading scale.
	h1: (props: { children?: React.ReactNode }) => (
		<SidebarGroupLabel className="px-4 pt-3">
			{props.children}
		</SidebarGroupLabel>
	),
	h2: (props: { children?: React.ReactNode }) => (
		<SidebarGroupLabel className="px-4 pt-3">
			{props.children}
		</SidebarGroupLabel>
	),
	h3: (props: { children?: React.ReactNode }) => (
		<SidebarGroupLabel className="px-4 pt-3">
			{props.children}
		</SidebarGroupLabel>
	),
	ul: (props: { children?: React.ReactNode }) => (
		<SidebarGroup className="py-1">
			<SidebarMenu>{props.children}</SidebarMenu>
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
 */
export async function compileHubSidebarMdx(
	source: string,
): Promise<React.ReactNode> {
	const { content } = await compileMDX({
		source,
		components: sidebarMdxComponents,
		options: { parseFrontmatter: true },
	})
	return content
}
