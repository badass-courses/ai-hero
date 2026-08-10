import type { Metadata } from 'next'
import LayoutClient from '@/components/layout-client'
import config from '@/config'
import { env } from '@/env.mjs'
import { getCachedAllLists } from '@/lib/lists-query'

import { PersonalizedLists } from './_components/personalized-lists'

export const revalidate = 3600
export const dynamic = 'force-static'

export const metadata: Metadata = {
	title: `AI Engineering Lists by ${config.author}`,
	openGraph: {
		images: [
			{
				url: `${env.NEXT_PUBLIC_URL}/api/og?title=${encodeURIComponent(`AI Engineering Posts by ${config.author}`)}`,
			},
		],
	},
}

export default async function ListsPage() {
	const lists = await getCachedAllLists()
	return (
		<LayoutClient withContainer className="">
			<main className="p-5">
				<h1 className="text-xl font-bold sm:text-2xl">Lists</h1>
				<PersonalizedLists lists={lists} />
			</main>
		</LayoutClient>
	)
}
