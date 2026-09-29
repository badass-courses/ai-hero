import * as React from 'react'
import type { Metadata } from 'next'
import LayoutClient from '@/components/layout-client'
import { TYPE } from '@/components/landing/type'
import { HubLayout } from '@/components/navigation/hub-layout'
import config from '@/config'
import { env } from '@/env.mjs'

import { cn } from '@coursebuilder/ui/utils/cn'

import { VideoSearch } from './_components/video-search'

export const revalidate = 3600
export const dynamic = 'force-static'

const title = `AI Engineering Videos by ${config.author}`

export const metadata: Metadata = {
	title,
	description:
		'Every AI Hero video you can watch: free posts and tutorials, plus the lessons from courses you own.',
	openGraph: {
		images: [
			{
				url: `${env.NEXT_PUBLIC_URL}/api/og?title=${encodeURIComponent(title)}`,
			},
		],
	},
}

export default function VideosIndexPage() {
	return (
		<LayoutClient withContainer withFooter={false}>
			{/* Dense catalog page, like /posts: the hub sidebar starts collapsed. */}
			<HubLayout sidebarDefaultCollapsed>
				<main className="flex min-h-[calc(100vh-var(--nav-height))] flex-col">
					<header className="px-[18px] py-12 sm:px-11 md:py-[52px]">
						<h1 className={cn(TYPE.title, 'text-balance')}>Videos</h1>
						<p
							className={cn(
								TYPE.lead,
								'mt-4 max-w-[65ch] text-[color:var(--ah-fg-muted)]',
							)}
						>
							Every video on AI Hero you can watch. Free posts and tutorials,
							plus the lessons from any course you own.
						</p>
					</header>
					<VideoSearch />
				</main>
			</HubLayout>
		</LayoutClient>
	)
}
