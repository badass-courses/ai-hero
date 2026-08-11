import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import LayoutClient from '@/components/layout-client'
import { env } from '@/env.mjs'
import { getCachedPage } from '@/lib/pages-query'

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

export const revalidate = 3600
export const dynamic = 'force-static'

export async function generateMetadata(): Promise<Metadata> {
	const page = await getCachedPage(PAGE_SLUG)

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
	const page = await getCachedPage(PAGE_SLUG)

	// No row, or an empty body, is a 404 rather than an empty shell. This page
	// exists to be sent to a team; a chrome-only version of it that returns 200
	// is worse than a missing page, because nothing alerts on it.
	if (!page?.fields.body) return notFound()

	return (
		<LayoutClient withContainer>
			<ForYourTeamBody
				source={page.fields.body}
				pageId={page.id}
				pageTitle={page.fields.title}
			/>
		</LayoutClient>
	)
}
