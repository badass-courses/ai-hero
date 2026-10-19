import type { Metadata } from 'next'
import {
	getSandcastleDocs,
	getSandcastleWeeklyDownloads,
	SANDCASTLE_DOCS_PATH,
	SANDCASTLE_OWNER,
	SANDCASTLE_REPO,
} from '@/lib/sandcastle-docs'
import { getRepoStarCount } from '@/lib/github-stars-query'

import { SandcastleShell } from './_components/docs-shell'
import { SandcastleLanding } from './_components/sandcastle-landing'

export const revalidate = 3600

export async function generateMetadata(): Promise<Metadata> {
	const { lead } = await getSandcastleDocs()
	const title = 'Sandcastle | AI Hero'
	return {
		title,
		description: lead,
		alternates: { canonical: SANDCASTLE_DOCS_PATH },
		openGraph: {
			title,
			description: lead,
			url: SANDCASTLE_DOCS_PATH,
			siteName: 'AI Hero',
			type: 'website',
		},
	}
}

export default async function SandcastlePage() {
	const [docs, stars, downloads] = await Promise.all([
		getSandcastleDocs(),
		getRepoStarCount(SANDCASTLE_OWNER, SANDCASTLE_REPO),
		getSandcastleWeeklyDownloads(),
	])

	return (
		<SandcastleShell docs={docs} current={null}>
			<SandcastleLanding docs={docs} stars={stars} downloads={downloads} />
		</SandcastleShell>
	)
}
