import { cache } from 'react'
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import LayoutClient from '@/components/layout-client'
import { env } from '@/env.mjs'
import { getPage } from '@/lib/pages-query'

import { ForYourTeamBody } from './_components/for-your-team-body'

/**
 * The CMS `page` row this route renders. A static segment under `/skills`, so
 * it takes precedence over `skills/[slug]` and no skill can shadow it.
 *
 * The slug is prefixed rather than bare `for-your-team` because the admin page
 * list is flat and the site already has a `/for-your-team` (team licences) —
 * two rows called the same thing is how the wrong one gets edited.
 */
const PAGE_SLUG = 'skills-for-your-team'

const TITLE = 'AI Skills for Real Engineering Teams'

/**
 * The row, fetched once per request.
 *
 * `generateMetadata` and the page component both need it, and they run in the
 * same request — so calling `getPage` directly from each ran the Drizzle query
 * and `PageSchema.safeParse` twice for every visit. `getPage` memoizes nothing
 * of its own (it is a plain query in a `'use server'` module), so the
 * deduplication has to happen at the call site.
 *
 * React `cache` rather than `unstable_cache`: this is per-request
 * deduplication, not caching across requests. The body is edited from
 * `/admin/pages` and has to appear on the next request, which a time-based
 * cache would delay.
 */
const getForYourTeamPage = cache(() => getPage(PAGE_SLUG))

export async function generateMetadata(): Promise<Metadata> {
	const page = await getForYourTeamPage()

	const title = page?.fields.title || TITLE
	const description =
		page?.fields.description ||
		'Watch this with your team: the engineering process behind Real Engineering, and the free skills that put it in your codebase.'

	return {
		title,
		description,
		openGraph: {
			title,
			description,
			images: [
				{
					url:
						page?.fields.socialImage?.url ||
						`${env.NEXT_PUBLIC_URL}/api/og/default?title=${encodeURIComponent(title)}`,
				},
			],
		},
	}
}

export default async function SkillsForYourTeamPage() {
	const page = await getForYourTeamPage()

	// No row, or an empty body, is a 404 rather than an empty shell. This page
	// exists to be sent to a team; a chrome-only version of it that returns 200
	// is worse than a missing page, because nothing alerts on it.
	if (!page?.fields.body) return notFound()

	return (
		<LayoutClient withContainer>
			<ForYourTeamBody source={page.fields.body} pageId={page.id} />
		</LayoutClient>
	)
}
