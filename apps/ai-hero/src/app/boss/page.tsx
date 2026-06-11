import type { Metadata, ResolvingMetadata } from 'next'
import { notFound } from 'next/navigation'
import LayoutClient from '@/components/layout-client'
import { env } from '@/env.mjs'
import { getPage } from '@/lib/pages-query'
import { compileMDX } from '@/utils/compile-mdx'

import BossLetterArticle from './[resourceSlug]/components/boss-letter-article'

const PAGE_SLUG = 'boss-letter'

export async function generateMetadata(
	props: {},
	parent: ResolvingMetadata,
): Promise<Metadata> {
	const page = await getPage(PAGE_SLUG)

	if (!page) {
		return parent as Metadata
	}

	return {
		title: page.fields.title,
		description: page.fields.description,
		openGraph: {
			title: page.fields.title,
			description: page.fields.description,
			images: [
				{
					url: `${env.NEXT_PUBLIC_URL}/api/og/default?title=${encodeURIComponent(page.fields.title || 'Invest in your team')}`,
				},
			],
		},
	}
}

export default async function BossPage() {
	const page = await getPage(PAGE_SLUG)

	if (!page || !page.fields?.body) {
		return notFound()
	}

	const { content } = await compileMDX(page.fields.body || '')

	return (
		<LayoutClient withContainer>
			<main className="py-10 sm:py-16">
				<div className="mb-10 flex flex-col items-center justify-center gap-2">
					<h1 className="font-heading w-full text-center text-3xl font-bold lg:text-4xl">
						{page.fields.title}
					</h1>
					<h2 className="font-heading text-primary w-full text-center text-lg font-medium lg:text-xl">
						Copy and paste this letter and send it to your boss.
					</h2>
				</div>
				<BossLetterArticle>{content}</BossLetterArticle>
			</main>
		</LayoutClient>
	)
}
