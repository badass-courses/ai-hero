import * as React from 'react'
import type { Metadata } from 'next'
import Search from '@/app/(search)/q/_components/search'
import LayoutClient from '@/components/layout-client'
import { HubLayout } from '@/components/navigation/hub-layout'
import config from '@/config'
import { env } from '@/env.mjs'
import { getAllLists } from '@/lib/lists-query'
import { getCachedPostsGraph } from '@/lib/posts-graph'
import { getAllPosts } from '@/lib/posts-query'
import { getServerAuthSession } from '@/server/auth'

import { PostActions } from './_components/post-actions'

export const dynamic = 'force-dynamic'

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
		<LayoutClient withContainer>
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

async function PostListActions({}: {}) {
	const { ability } = await getServerAuthSession()
	if (!ability.can('create', 'Content') || !ability.can('update', 'Content')) {
		return null
	}
	const allPosts = await getAllPosts()
	const allLists = await getAllLists()

	return <PostActions allPosts={allPosts} allLists={allLists} />
}
