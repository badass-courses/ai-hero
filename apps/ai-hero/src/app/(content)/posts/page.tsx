import * as React from 'react'
import type { Metadata } from 'next'
import Search from '@/app/(search)/q/_components/search'
import LayoutClient from '@/components/layout-client'
import { HubLayout } from '@/components/navigation/hub-layout'
import config from '@/config'
import { env } from '@/env.mjs'
import { getCachedPostsGraph } from '@/lib/posts-graph'

import { PostListActions } from './_components/post-list-actions'

export const revalidate = 3600
export const dynamic = 'force-static'

export const metadata: Metadata = {
	title: `AI Engineering Posts by ${config.author}`,
	openGraph: {
		images: [
			{
				url: `${env.NEXT_PUBLIC_URL}/api/og?title=${encodeURIComponent(`AI Engineering Posts by ${config.author}`)}`,
			},
		],
	},
}

export default async function PostsIndexPage() {
	const graph = await getCachedPostsGraph()
	return (
		<LayoutClient withContainer withFooter={false}>
			{/* Dense catalog page: hub sidebar starts as the collapsed icon rail
			    (expands in place) so the listing keeps its width. */}
			<HubLayout sidebarDefaultCollapsed>
				<main className="flex min-h-[calc(100vh-var(--nav-height))] flex-col lg:flex-row">
					<div className="mx-auto flex w-full flex-col">
						<Search graph={graph} />
					</div>
					<React.Suspense fallback={null}>
						<PostListActions />
					</React.Suspense>
				</main>
			</HubLayout>
		</LayoutClient>
	)
}
