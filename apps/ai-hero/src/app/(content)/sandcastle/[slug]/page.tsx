import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { getSandcastleDocs, getSandcastleDocsPage } from '@/lib/sandcastle-docs'

import { DocsArticle } from '../_components/docs-article'
import { SandcastleShell } from '../_components/docs-shell'

export const revalidate = 3600

type Props = {
	params: Promise<{ slug: string }>
}

export async function generateStaticParams() {
	const { pages } = await getSandcastleDocs()
	return pages.map((page) => ({ slug: page.slug }))
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
	const found = await getSandcastleDocsPage((await params).slug)
	if (!found) return {}
	const { page, docs } = found
	const title = `${page.title} | Sandcastle docs | AI Hero`
	const description = page.description || docs.lead
	return {
		title,
		description,
		alternates: { canonical: page.href },
		openGraph: {
			title,
			description,
			url: page.href,
			siteName: 'AI Hero',
			type: 'article',
			images: [
				{
					url: `/api/og?title=${encodeURIComponent(page.title)}`,
					width: 1200,
					height: 630,
				},
			],
		},
	}
}

export default async function SandcastleDocsPage({ params }: Props) {
	const found = await getSandcastleDocsPage((await params).slug)
	if (!found) notFound()
	const { docs, page, previous, next } = found

	return (
		<SandcastleShell docs={docs} current={page.slug}>
			<DocsArticle page={page} previous={previous} next={next} />
		</SandcastleShell>
	)
}
