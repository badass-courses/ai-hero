import config from '@/config'
import { env } from '@/env.mjs'
import { Feed } from 'feed'

import sitemap from '../sitemap'

export const revalidate = 3600
export const dynamic = 'force-static'

async function generateRSS() {
	const sitemapEntries = await sitemap()

	const feed = new Feed({
		title: `${env.NEXT_PUBLIC_SITE_TITLE} RSS Feed`,
		description: config.description,
		id: env.COURSEBUILDER_URL,
		link: env.COURSEBUILDER_URL,
		language: 'en',
		updated: sitemapEntries.reduce((latest, entry) => {
			const value = new Date(entry.lastModified)
			return value > latest ? value : latest
		}, new Date(0)),
		feedLinks: {
			rss: `${env.COURSEBUILDER_URL}/rss.xml`,
		},
		author: {
			name: config.author,
			email: env.NEXT_PUBLIC_SUPPORT_EMAIL,
			link: env.COURSEBUILDER_URL,
		},
		copyright: 'Copyright © ' + new Date().getFullYear() + ' ' + config.author,
	})

	sitemapEntries
		.filter((entry) => entry.url !== `${env.COURSEBUILDER_URL}/`)
		.forEach((entry) => {
			feed.addItem({
				title: entry.title,
				id: entry.url,
				link: entry.url,
				description: entry.description,
				date: new Date(entry.lastModified),
			})
		})

	return feed.rss2()
}

export async function GET() {
	return new Response(await generateRSS(), {
		headers: {
			'Content-Type': 'text/xml; charset=utf-8',
			'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=86400',
		},
	})
}
