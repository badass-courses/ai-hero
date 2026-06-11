import config from '@/config'
import { env } from '@/env.mjs'
import { getList } from '@/lib/lists-query'
import { getSkillChangelogEntries } from '@/lib/skill-changelog-query'
import { SKILLS_LIST_ID } from '@/lib/skills-content'
import { Feed } from 'feed'

const MAX_ITEMS = 50
const CHANGELOG_FETCH_LIMIT = 100

type FeedItem = {
	id: string
	title: string
	link: string
	description?: string
	date: Date
}

function toValidDate(value: unknown): Date | null {
	if (!value) return null

	const date = value instanceof Date ? value : new Date(String(value))

	return Number.isNaN(date.getTime()) ? null : date
}

function contentTimestamp(...values: unknown[]): Date {
	for (const value of values) {
		const date = toValidDate(value)
		if (date) return date
	}

	return new Date(0)
}

async function generateRSS() {
	const [changelog, skillsList] = await Promise.all([
		getSkillChangelogEntries({ limit: CHANGELOG_FETCH_LIMIT }),
		getList(SKILLS_LIST_ID),
	])

	const items: FeedItem[] = []

	for (const entry of changelog) {
		const slug = String(entry.fields?.slug ?? entry.id)
		const title = String(entry.fields?.title ?? 'Skill update')
		const description = entry.fields?.description || entry.fields?.summary
		const link = `${env.COURSEBUILDER_URL}/skills/${slug}`
		items.push({
			id: link,
			title,
			link,
			description: description ? String(description) : undefined,
			date: contentTimestamp(
				entry.fields?.publishedAt,
				entry.updatedAt,
				entry.createdAt,
			),
		})
	}

	for (const item of skillsList?.resources ?? []) {
		const resource = item.resource
		if (!resource) continue
		const slug = String(resource.fields?.slug ?? resource.id)
		const title = String(resource.fields?.title ?? 'Skill')
		const description = resource.fields?.description || resource.fields?.summary
		const link = `${env.COURSEBUILDER_URL}/${slug}`
		items.push({
			id: link,
			title,
			link,
			description: description ? String(description) : undefined,
			date: contentTimestamp(
				resource.fields?.publishedAt,
				resource.updatedAt,
				resource.createdAt,
			),
		})
	}

	const seen = new Set<string>()
	const sortedItems = items
		.filter((item) => {
			if (seen.has(item.id)) return false
			seen.add(item.id)
			return true
		})
		.sort((a, b) => b.date.getTime() - a.date.getTime())
		.slice(0, MAX_ITEMS)

	const feedUpdated = sortedItems[0]?.date ?? new Date(0)

	const feed = new Feed({
		title: `${env.NEXT_PUBLIC_SITE_TITLE} Skills`,
		description:
			'New skill posts and changelog updates from AI Hero — practical skills for engineers using AI without giving up their standards.',
		id: `${env.COURSEBUILDER_URL}/skills`,
		link: `${env.COURSEBUILDER_URL}/skills`,
		language: 'en',
		updated: feedUpdated,
		feedLinks: {
			rss: `${env.COURSEBUILDER_URL}/skills/rss.xml`,
		},
		author: {
			name: config.author,
			email: env.NEXT_PUBLIC_SUPPORT_EMAIL,
			link: env.COURSEBUILDER_URL,
		},
		copyright: `Copyright © ${new Date().getFullYear()} ${config.author}`,
	})

	sortedItems.forEach((item) => feed.addItem(item))

	return feed.rss2()
}

export async function GET() {
	return new Response(await generateRSS(), {
		headers: {
			'Content-Type': 'text/xml; charset=utf-8',
			'Cache-Control': 's-maxage=1, stale-while-revalidate',
		},
	})
}
