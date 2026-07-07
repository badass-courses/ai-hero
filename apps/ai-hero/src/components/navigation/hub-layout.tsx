import * as React from 'react'
import { getCachedHubSidebarBody } from '@/lib/hub-sidebar-ia'
import { log } from '@/server/logger'

import { SidebarProvider } from '@coursebuilder/ui'

import { HUB_SIDEBAR_FALLBACK_MDX } from './hub-sidebar-fallback'
import { SidebarMinimalFallback } from './hub-sidebar'
import { PinnedSeriesNav } from './sidebar/pinned-series-nav'
import { SidebarErrorBoundary } from './sidebar/sidebar-client'
import { compileHubSidebarMdx } from './sidebar/sidebar-mdx'
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
async function renderSidebarContent(
	hideWhatsNew: boolean,
): Promise<React.ReactNode> {
	const body = (await getCachedHubSidebarBody()) ?? HUB_SIDEBAR_FALLBACK_MDX

	let compiled: React.ReactNode | null = null
	try {
		compiled = await compileHubSidebarMdx(body, { hideWhatsNew })
	} catch (error) {
		void log.error('hub-sidebar.mdx.compile.error', {
			error: error instanceof Error ? error.message : String(error),
		})
		if (body !== HUB_SIDEBAR_FALLBACK_MDX) {
			try {
				compiled = await compileHubSidebarMdx(HUB_SIDEBAR_FALLBACK_MDX, {
					hideWhatsNew,
				})
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
}: {
	children: React.ReactNode
	sidebarDefaultCollapsed?: boolean
	/** Suppress the "What's New" category — set on standalone post pages. */
	hideWhatsNew?: boolean
}) {
	const sidebarContent = await renderSidebarContent(hideWhatsNew)

	return (
		<SidebarProvider
			defaultOpen
			className="min-h-0 has-data-[variant=inset]:bg-background"
		>
			<HubSidebarShell defaultCollapsed={sidebarDefaultCollapsed}>
				{/* Pinned "In this series" group — renders only when a list context
				    is present (inside the [post] layout); no-op everywhere else. */}
				<PinnedSeriesNav />
				{sidebarContent}
			</HubSidebarShell>
			<div className="min-w-0 flex-1">{children}</div>
		</SidebarProvider>
	)
}
