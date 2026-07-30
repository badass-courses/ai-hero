import * as React from 'react'
import { getCachedHubSidebarBody } from '@/lib/hub-sidebar-ia'
import { listHomeHref } from '@/lib/list-home'
import { log } from '@/server/logger'

import { SidebarProvider } from '@coursebuilder/ui'

import Footer from './footer'
import { HUB_SIDEBAR_FALLBACK_MDX } from './hub-sidebar-fallback'
import { SidebarMinimalFallback } from './hub-sidebar'
import { PinnedSeriesNav } from './sidebar/pinned-series-nav'
import { SidebarErrorBoundary } from './sidebar/sidebar-client'
import { compileHubSidebarMdx } from './sidebar/sidebar-mdx'
import { buildCollapsedSidebarSections } from './sidebar/sidebar-rail'
import { HubSidebarShell } from './sidebar/sidebar-shell'

/**
 * Resolve the sidebar content. Single source of truth is the `hub-sidebar`
 * MDX: the live CMS page when present, otherwise the bundled default
 * (`HUB_SIDEBAR_FALLBACK_MDX`) — both go through the same components map, so
 * there is no separately modeled fallback IA to drift.
 *
 * Layered so a broken CMS edit can never kill nav: a malformed page body
 * falls back to the bundled default; a render-time crash inside the compiled
 * tree is caught by `SidebarErrorBoundary`; and the boundary's own fallback is
 * the tiny static `SidebarMinimalFallback`, which has no data deps and can't
 * itself fail.
 */
async function compileBody(
	body: string,
	hideWhatsNew: boolean,
	insert: React.ReactNode,
): Promise<React.ReactNode> {
	if (!insert) return compileHubSidebarMdx(body, { hideWhatsNew })

	// The insert belongs between Explore and Topics, and the sidebar body is one
	// MDX document — so compile it as two, either side of the Topics heading.
	// Splitting on a top-level heading leaves two well-formed documents; if the
	// body has no Topics category, the insert simply lands last.
	const topics = body.match(/^## Topics\s*$/m)
	const at = topics?.index ?? body.length
	const [head, tail] = await Promise.all([
		compileHubSidebarMdx(body.slice(0, at), { hideWhatsNew }),
		compileHubSidebarMdx(body.slice(at), { hideWhatsNew }),
	])
	return (
		<>
			{head}
			{insert}
			{tail}
		</>
	)
}

async function renderSidebarContent(
	body: string,
	hideWhatsNew: boolean,
	insert?: React.ReactNode,
): Promise<React.ReactNode> {
	let compiled: React.ReactNode | null = null
	try {
		compiled = await compileBody(body, hideWhatsNew, insert)
	} catch (error) {
		void log.error('hub-sidebar.mdx.compile.error', {
			error: error instanceof Error ? error.message : String(error),
		})
		if (body !== HUB_SIDEBAR_FALLBACK_MDX) {
			try {
				compiled = await compileBody(
					HUB_SIDEBAR_FALLBACK_MDX,
					hideWhatsNew,
					insert,
				)
			} catch {
				compiled = null
			}
		}
	}

	return (
		<SidebarErrorBoundary fallback={<SidebarMinimalFallback />}>
			{compiled ?? <SidebarMinimalFallback />}
		</SidebarErrorBoundary>
	)
}

/**
 * Wraps free-learning ("hub") page content with the docs-style sidebar.
 * Server component: resolves the MDX-driven sidebar (with static fallback),
 * then renders it beside the page content. Use inside `<LayoutClient>` on hub
 * pages.
 *
 * `sidebarDefaultCollapsed` puts the sidebar in icon-rail mode — for dense
 * catalog pages (`/posts`, the dictionary index) where the full sidebar would
 * crowd the listing (lat.md/decisions.md "Icon-rail sidebar for catalog
 * pages"). It expands in place on toggle.
 */
export async function HubLayout({
	children,
	sidebarDefaultCollapsed = false,
	hideWhatsNew = false,
	currentListSlug,
	sidebarInsert,
	sidebarFooter,
	withFooter = true,
}: {
	children: React.ReactNode
	sidebarDefaultCollapsed?: boolean
	/** Suppress the "What's New" category — set on standalone post pages. */
	hideWhatsNew?: boolean
	/** Slug of the list the current post belongs to (drives series nav). */
	currentListSlug?: string
	/**
	 * Page-specific sidebar group, dropped in between Explore and Topics. For
	 * nav that only makes sense on one page (the Map's in-page question
	 * anchors), which has no business in the shared MDX body.
	 */
	sidebarInsert?: React.ReactNode
	/** Card pinned to the foot of the sidebar, below every group. */
	sidebarFooter?: React.ReactNode
	/**
	 * Render the site footer inside the content column. On by default — hub
	 * pages pair this with `<LayoutClient withFooter={false}>` so the page has
	 * exactly one footer and it sits beside the sidebar.
	 */
	withFooter?: boolean
}) {
	const body = (await getCachedHubSidebarBody()) ?? HUB_SIDEBAR_FALLBACK_MDX
	const sidebarContent = await renderSidebarContent(
		body,
		hideWhatsNew,
		sidebarInsert,
	)
	const collapsedSections = sidebarDefaultCollapsed
		? buildCollapsedSidebarSections(body)
		: []

	// Hybrid series nav: if the current list has its own link in the sidebar IA
	// (e.g. a tentpole, or its home-override — /skills for the skills list), it
	// expands in place (SidebarNavLink) — skip the pinned block. Otherwise the
	// pinned "In this series" block is the fallback so the lessons are never
	// orphaned. See decisions.md "Series posts keep the hub sidebar".
	const listInSidebar = Boolean(
		currentListSlug &&
			(body.includes(`](/${currentListSlug})`) ||
				body.includes(`](${listHomeHref(currentListSlug)})`)),
	)

	return (
		<SidebarProvider
			defaultOpen
			className="min-h-0 has-data-[variant=inset]:bg-background"
		>
			<HubSidebarShell
				key={sidebarDefaultCollapsed ? 'collapsed' : 'expanded'}
				defaultCollapsed={sidebarDefaultCollapsed}
				collapsedSections={collapsedSections}
			>
				{!listInSidebar ? <PinnedSeriesNav /> : null}
				{sidebarContent}
				{sidebarFooter ? <div className="mt-6 px-1">{sidebarFooter}</div> : null}
			</HubSidebarShell>
			{/* The footer belongs INSIDE the content column, not after the grid:
			    that is what lets the sidebar's right border run the whole page,
			    footer included, instead of stopping where the main content does.
			    Callers therefore pass `withFooter={false}` to `LayoutClient` —
			    see the `withFooter` note on that component. */}
			<div className="flex min-w-0 flex-1 flex-col">
				<div className="flex-1">{children}</div>
				{withFooter ? <Footer /> : null}
			</div>
		</SidebarProvider>
	)
}
