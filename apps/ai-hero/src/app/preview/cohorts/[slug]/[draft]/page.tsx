import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { ParsedUrlQuery } from 'querystring'
import { notFound } from 'next/navigation'

import { CohortPageView } from '../../../../(content)/cohorts/[slug]/page'

/**
 * Local cohort-body preview: renders the real cohort page with its sales body
 * read from `content/cohorts/<slug>/<draft>.mdx` instead of the CMS row.
 *
 * It exists because development shares production's database, so a body saved
 * in the CMS just to look at it is already live. Everything but the body is
 * the real page (hero, rail, pricing, component map), so what you see here is
 * what the cohort will look like once the file is pasted into the CMS. Search
 * params pass through, so `?allowPurchase=true` still shows the purchase rail.
 *
 * Dev-only, for the reason `/preview/landing` gives: the file on disk is a
 * working copy, not a second source of truth.
 */
export const dynamic = 'force-dynamic'

export const metadata = { robots: { index: false, follow: false } }

const SAFE_SEGMENT = /^[a-z0-9-]+$/

export default async function CohortBodyPreviewPage(props: {
	params: Promise<{ slug: string; draft: string }>
	searchParams: Promise<ParsedUrlQuery>
}) {
	if (process.env.NODE_ENV === 'production') notFound()

	const { slug, draft } = await props.params
	if (!SAFE_SEGMENT.test(slug) || !SAFE_SEGMENT.test(draft)) notFound()

	const bodySource = await fs
		.readFile(
			path.join(process.cwd(), 'content', 'cohorts', slug, `${draft}.mdx`),
			'utf-8',
		)
		.catch(() => null)
	if (bodySource === null) notFound()

	return CohortPageView({
		params: Promise.resolve({ slug }),
		searchParams: props.searchParams,
		bodySource,
	})
}
