import * as React from 'react'
import { type Post } from '@/lib/posts'
import { getCachedAllPosts } from '@/lib/posts-query'

import { SidebarProvider } from '@coursebuilder/ui'

import { HubSidebar } from './hub-sidebar'
import { type SidebarLink } from './hub-sidebar-data'

/**
 * Server-fetched "What's New" items: the most recent published, public posts.
 * Fetched here (not client-side) so the sidebar renders with data in the
 * initial HTML — no layout shift. Uses the existing cached posts query.
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
 * Wraps free-learning ("hub") page content with the docs-style sidebar.
 * Server component: fetches What's New, then renders the client sidebar + the
 * page content side by side. Use inside `<LayoutClient>` on hub pages.
 */
export async function HubLayout({ children }: { children: React.ReactNode }) {
	const whatsNew = await getWhatsNew()

	return (
		<SidebarProvider
			defaultOpen
			className="min-h-0 has-data-[variant=inset]:bg-background"
		>
			<HubSidebar whatsNew={whatsNew} />
			<div className="min-w-0 flex-1">{children}</div>
		</SidebarProvider>
	)
}
