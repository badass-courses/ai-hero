import { env } from '@/env.mjs'
import { getList } from '@/lib/lists-query'
import {
	getSkillChangelogCount,
	getSkillChangelogEntries,
	type SkillChangelogEntry,
} from '@/lib/skill-changelog-query'
import {
	FEATURED_SKILL_LINKS,
	SKILLS_GUIDE_ITEMS,
	SKILLS_HERO,
	SKILLS_LIST_ID,
	SKILLS_PAGE_SIZE,
	SKILLS_REPO_URL,
} from '@/lib/skills-content'

import { createMarkdownResponse } from '../route-utils'

export async function GET(request: Request) {
	const url = new URL(request.url)
	const currentPage = Math.max(
		Number(url.searchParams.get('page') ?? '1') || 1,
		1,
	)
	const offset = (currentPage - 1) * SKILLS_PAGE_SIZE

	const [entries, totalEntries, skillsList] = await Promise.all([
		getSkillChangelogEntries({ limit: SKILLS_PAGE_SIZE, offset }),
		getSkillChangelogCount(),
		getList(SKILLS_LIST_ID),
	])

	const totalPages = Math.max(Math.ceil(totalEntries / SKILLS_PAGE_SIZE), 1)
	const baseUrl = env.COURSEBUILDER_URL

	const skillCatalogue = (skillsList?.resources ?? [])
		.map((item) => item.resource)
		.filter((resource): resource is NonNullable<typeof resource> =>
			Boolean(resource?.fields?.slug),
		)

	const markdown = buildSkillsMarkdown({
		baseUrl,
		entries,
		skillCatalogue,
		currentPage,
		totalPages,
		totalEntries,
	})

	return createMarkdownResponse(markdown)
}

type CatalogueItem = {
	id: string
	fields?: {
		slug?: string | null
		title?: string | null
		description?: string | null
		summary?: string | null
	} | null
}

function buildSkillsMarkdown({
	baseUrl,
	entries,
	skillCatalogue,
	currentPage,
	totalPages,
	totalEntries,
}: {
	baseUrl: string
	entries: SkillChangelogEntry[]
	skillCatalogue: CatalogueItem[]
	currentPage: number
	totalPages: number
	totalEntries: number
}) {
	const frontmatter = [
		'---',
		`title: "${SKILLS_HERO.title}"`,
		`description: "${SKILLS_HERO.tagline}"`,
		`url: "${baseUrl}/skills"`,
		`rss: "${baseUrl}/skills/rss.xml"`,
		`page: ${currentPage}`,
		`totalPages: ${totalPages}`,
		`totalChangelogEntries: ${totalEntries}`,
		'---',
	].join('\n')

	const featured = FEATURED_SKILL_LINKS.map(
		({ name, slug }) => `- [\`/${name}\`](${baseUrl}/${slug})`,
	).join('\n')

	const hero = [
		`# ${SKILLS_HERO.title}`,
		'',
		SKILLS_HERO.tagline,
		'',
		'## Install',
		'',
		'```bash',
		SKILLS_HERO.installCommand,
		'```',
		'',
		`Source: [${SKILLS_REPO_URL}](${SKILLS_REPO_URL})`,
		'',
		'### Featured skills',
		'',
		featured,
	].join('\n')

	const skillSet = [
		'## The skill set',
		'',
		skillCatalogue.length === 0
			? '_No skills published yet._'
			: skillCatalogue
					.map((item) => renderCatalogueItem(item, baseUrl))
					.join('\n\n'),
	].join('\n')

	const getOriented = [
		'## Get oriented',
		'',
		SKILLS_GUIDE_ITEMS.map(
			({ label, title, href }) =>
				`- **${label}** — [${title}](${baseUrl}${href})`,
		).join('\n'),
	].join('\n')

	const changelog = [
		`## Changelog (page ${currentPage} of ${totalPages})`,
		'',
		entries.length === 0
			? '_No changelog entries on this page._'
			: entries
					.map((entry) => renderChangelogEntry(entry, baseUrl))
					.join('\n\n'),
	].join('\n')

	return [
		frontmatter,
		'',
		hero,
		'',
		skillSet,
		'',
		getOriented,
		'',
		changelog,
		'',
	].join('\n')
}

function renderCatalogueItem(item: CatalogueItem, baseUrl: string) {
	const slug = String(item.fields?.slug ?? item.id)
	const title = String(item.fields?.title ?? 'Untitled skill')
	const description = item.fields?.description || item.fields?.summary
	const link = `${baseUrl}/${slug}`
	const markdownLink = `${baseUrl}/${slug}.md`

	const lines = [`### [${title}](${link})`]
	if (description) {
		lines.push('', String(description))
	}
	lines.push('', `Markdown: ${markdownLink}`)
	return lines.join('\n')
}

function renderChangelogEntry(entry: SkillChangelogEntry, baseUrl: string) {
	const slug = String(entry.fields?.slug ?? entry.id)
	const title = String(entry.fields?.title ?? 'Untitled skill update')
	const description = entry.fields?.description || entry.fields?.summary
	const publishedAt = entry.createdAt
		? new Intl.DateTimeFormat('en-US', {
				month: 'short',
				day: 'numeric',
				year: 'numeric',
			}).format(new Date(entry.createdAt))
		: null
	const link = `${baseUrl}/skills/${slug}`

	const lines = [`### [${title}](${link})`]
	if (publishedAt) {
		lines.push('', `_${publishedAt}_`)
	}
	if (description) {
		lines.push('', String(description))
	}
	return lines.join('\n')
}
