import * as React from 'react'
import { unstable_cache } from 'next/cache'
import { getPage } from '@/lib/pages-query'
import { type Post } from '@/lib/posts'
import { getCachedAllPosts } from '@/lib/posts-query'
import { log } from '@/server/logger'

import { SidebarProvider } from '@coursebuilder/ui'

import { type SidebarLink } from './hub-sidebar-data'
import { HubSidebarStaticContent } from './hub-sidebar'
import { SidebarErrorBoundary } from './sidebar/sidebar-client'
import { compileHubSidebarMdx } from './sidebar/sidebar-mdx'
import { HubSidebarShell } from './sidebar/sidebar-shell'

/**
 * Cached body of the CMS `hub-sidebar` page (the MDX that defines the sidebar
 * menu — see lat.md/decisions.md "MDX-driven sidebar"). Only published pages
 * count; `null` means "no curated sidebar, use the static fallback". Joined to
 * the 'pages' revalidation tag so `updatePage` invalidates it on save.
 */
const getCachedHubSidebarBody = unstable_cache(
	async (): Promise<string | null> => {
		const page = await getPage('hub-sidebar')
		if (!page || page.fields.state !== 'published') return null
		const body = page.fields.body?.trim()
		return body ? body : null
	},
	['hub-sidebar-page-v1'],
	{ revalidate: 3600, tags: ['pages'] },
)

/**
 * Server-fetched "What's New" items for the STATIC FALLBACK sidebar (the
 * MDX-driven sidebar loads its own via `<WhatsNew />`). Fetched here (not
 * client-side) so the fallback renders with data in the initial HTML.
 */
async function getWhatsNew(limit = 3): Promise<SidebarLink[]> {
	try {
		const posts: Post[] = await getCachedAllPosts()
		return posts
			.filter(
				(p: Post) =>
					p?.fields?.state === 'published' &&
					p?.fields?.visibility === 'public' &&
					Boolean(p?.fields?.slug) &&
					Boolean(p?.fields?.title),
			)
			.slice(0, limit)
			.map((p: Post) => ({ label: p.fields.title, href: `/${p.fields.slug}` }))
	} catch {
		return []
	}
}

/**
 * Resolve the sidebar content: the compiled `hub-sidebar` MDX when the page
 * exists and compiles, otherwise the static `hub-sidebar-data.ts` fallback.
 * Compile failures are caught here; render-time failures inside the compiled
 * tree are caught by `SidebarErrorBoundary`. Either way nav survives.
 */
async function renderSidebarContent(): Promise<React.ReactNode> {
	const fallback = <HubSidebarStaticContent whatsNew={await getWhatsNew()} />

	let compiled: React.ReactNode | null = null
	try {
		const body = await getCachedHubSidebarBody()
		if (body) {
			compiled = await compileHubSidebarMdx(body)
		}
	} catch (error) {
		void log.error('hub-sidebar.mdx.compile.error', {
			error: error instanceof Error ? error.message : String(error),
		})
	}

	if (compiled === null) return fallback

	return (
		<SidebarErrorBoundary fallback={fallback}>{compiled}</SidebarErrorBoundary>
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
}: {
	children: React.ReactNode
	sidebarDefaultCollapsed?: boolean
}) {
	const sidebarContent = await renderSidebarContent()

	return (
		<SidebarProvider
			defaultOpen
			className="min-h-0 has-data-[variant=inset]:bg-background"
		>
			<HubSidebarShell defaultCollapsed={sidebarDefaultCollapsed}>
				{sidebarContent}
			</HubSidebarShell>
			<div className="min-w-0 flex-1">{children}</div>
		</SidebarProvider>
	)
}
