import { unstable_cache } from 'next/cache'
import { Octokit } from '@octokit/rest'

const DICTIONARY_OWNER = 'mattpocock'
const DICTIONARY_REPO = 'dictionary-of-ai-coding'
const DICTIONARY_REF = 'main'
const DICTIONARY_REVALIDATE_SECONDS = 3600

export type DictionarySection = {
	title: string
	entries: DictionaryEntrySummary[]
}

export type DictionaryEntrySummary = {
	title: string
	slug: string
	path: string
	githubUrl: string
	description: string
	aliases: string[]
	sectionTitle: string
	position: number
}

export type DictionaryEntry = DictionaryEntrySummary & {
	body: string
	rawBody: string
}

export type DictionaryData = {
	sections: DictionarySection[]
	entries: DictionaryEntry[]
	sourceUrl: string
	updatedAt: string
}

type GithubFile = {
	content?: string
	encoding?: string
}

type DictionaryFrontmatter = {
	description: string
	aliases: string[]
}

function toValidIsoDate(value: unknown): string | null {
	if (!value) return null

	const date = value instanceof Date ? value : new Date(String(value))

	return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

const octokit = new Octokit({
	auth: process.env.GITHUB_TOKEN || process.env.GH_TOKEN || undefined,
	userAgent: 'ai-hero-dictionary/1.0.0',
})

export const AI_CODING_DICTIONARY_REVALIDATE_SECONDS =
	DICTIONARY_REVALIDATE_SECONDS

export const AI_CODING_DICTIONARY_SOURCE_URL = `https://github.com/${DICTIONARY_OWNER}/${DICTIONARY_REPO}`

export const AI_CODING_DICTIONARY_TITLE = 'AI Coding Dictionary'
export const AI_CODING_DICTIONARY_DESCRIPTION =
	'The vocabulary of AI coding, translated into plain English for engineers.'

export const AI_CODING_DICTIONARY_OG_IMAGE_URL =
	'https://res.cloudinary.com/total-typescript/image/upload/v1777983728/ai-coding-dictionary-og_2x.jpg'

export function getAiCodingDictionaryOgImageUrl(title?: string) {
	if (!title || title === AI_CODING_DICTIONARY_TITLE) {
		return AI_CODING_DICTIONARY_OG_IMAGE_URL
	}
	return `/api/og?title=${encodeURIComponent(title)}`
}

async function getGithubMarkdownFile(path: string) {
	try {
		const response = await octokit.rest.repos.getContent({
			owner: DICTIONARY_OWNER,
			repo: DICTIONARY_REPO,
			path,
			ref: DICTIONARY_REF,
		})

		if (Array.isArray(response.data) || response.data.type !== 'file') {
			throw new Error(`Expected GitHub file at ${path}`)
		}

		const file = response.data as GithubFile
		if (!file.content || file.encoding !== 'base64') {
			throw new Error(`Expected base64 GitHub file content for ${path}`)
		}

		return Buffer.from(file.content, 'base64').toString('utf8')
	} catch (error) {
		const status =
			typeof error === 'object' && error && 'status' in error
				? Number(error.status)
				: undefined

		if (status !== 403) {
			throw error
		}

		const response = await fetch(
			`https://raw.githubusercontent.com/${DICTIONARY_OWNER}/${DICTIONARY_REPO}/${DICTIONARY_REF}/${path
				.split('/')
				.map(encodeURIComponent)
				.join('/')}`,
			{ next: { revalidate: DICTIONARY_REVALIDATE_SECONDS } },
		)

		if (!response.ok) {
			throw new Error(
				`Failed to fetch dictionary ${path} fallback: ${response.status}`,
			)
		}

		return response.text()
	}
}

async function getReadmeMarkdown() {
	return getGithubMarkdownFile('README.md')
}

async function getDictionaryRefUpdatedAt() {
	try {
		const response = await octokit.rest.repos.getBranch({
			owner: DICTIONARY_OWNER,
			repo: DICTIONARY_REPO,
			branch: DICTIONARY_REF,
		})

		return (
			toValidIsoDate(response.data.commit.commit.committer?.date) ??
			toValidIsoDate(response.data.commit.commit.author?.date)
		)
	} catch {
		return null
	}
}

function titleToDictionaryPath(title: string) {
	return `dictionary/${title}.md`
}

function titleToGithubUrl(title: string) {
	return `${AI_CODING_DICTIONARY_SOURCE_URL}/blob/${DICTIONARY_REF}/${titleToDictionaryPath(
		title,
	)
		.split('/')
		.map(encodeURIComponent)
		.join('/')}`
}

export function slugFromTitle(title: string) {
	return title
		.toLowerCase()
		.replace(/&/g, ' and ')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
}

function anchorFromTitle(title: string) {
	return title
		.toLowerCase()
		.replace(/[^a-z0-9\s-]/g, '')
		.trim()
		.replace(/\s+/g, '-')
}

export function stripMarkdown(markdown: string) {
	return markdown
		.replace(/```[\s\S]*?```/g, '')
		.replace(/`([^`]+)`/g, '$1')
		.replace(/!\[[^\]]*\]\([^)]*\)/g, '')
		.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
		.replace(/^\s*[-+]\s+/gm, '')
		.replace(/[*_>#]/g, '')
		.replace(/\s+/g, ' ')
		.trim()
}

function getDescription(markdown: string) {
	const firstParagraph = markdown
		.split(/\n\s*\n/)
		.map((part) => part.trim())
		.find((part) => part.length > 0)

	if (!firstParagraph) return ''

	const description = stripMarkdown(firstParagraph)
	return description.length > 180
		? `${description.slice(0, 177).trim()}...`
		: description
}

async function getDictionarySourceFrontmatter() {
	let dictionaryFiles: Array<{ path?: string; type?: string }> = []

	try {
		const response = await octokit.rest.git.getTree({
			owner: DICTIONARY_OWNER,
			repo: DICTIONARY_REPO,
			tree_sha: DICTIONARY_REF,
			recursive: 'true',
		})

		dictionaryFiles = response.data.tree.filter(
			(item) =>
				item.type === 'blob' &&
				item.path?.startsWith('dictionary/') &&
				item.path.endsWith('.md'),
		)
	} catch (error) {
		const status =
			typeof error === 'object' && error && 'status' in error
				? Number(error.status)
				: undefined

		if (status !== 403) {
			throw error
		}
	}

	const frontmatterByPath = new Map<string, DictionaryFrontmatter>()

	await Promise.all(
		dictionaryFiles.map(async (file) => {
			if (!file.path) return

			try {
				const rawUrl = `https://raw.githubusercontent.com/${DICTIONARY_OWNER}/${DICTIONARY_REPO}/${DICTIONARY_REF}/${file.path
					.split('/')
					.map(encodeURIComponent)
					.join('/')}`
				const sourceResponse = await fetch(rawUrl, {
					next: { revalidate: DICTIONARY_REVALIDATE_SECONDS },
					signal: AbortSignal.timeout(5000),
				})

				if (!sourceResponse.ok) return

				frontmatterByPath.set(
					file.path,
					parseDictionaryFrontmatter(await sourceResponse.text()),
				)
			} catch {
				return
			}
		}),
	)

	return frontmatterByPath
}

function parseDictionaryFrontmatter(markdown: string): DictionaryFrontmatter {
	if (!markdown.startsWith('---\n')) {
		return { description: '', aliases: [] }
	}

	const endIndex = markdown.indexOf('\n---', 4)
	if (endIndex < 0) return { description: '', aliases: [] }

	const yaml = markdown.slice(4, endIndex).trim()
	const aliases: string[] = []
	let description = ''
	let readingAliases = false

	for (const line of yaml.split('\n')) {
		const trimmed = line.trim()
		if (!trimmed || trimmed.startsWith('#')) continue

		const scalarMatch = trimmed.match(/^(description|summary|blurb):\s*(.*)$/)
		if (scalarMatch?.[1]) {
			readingAliases = false
			const value = scalarMatch[2]?.trim() ?? ''
			if (!description && value) {
				description = unquoteYamlScalar(value)
			}
			continue
		}

		if (trimmed === 'aliases:') {
			readingAliases = true
			continue
		}

		if (readingAliases) {
			const aliasMatch = trimmed.match(/^-\s*(.+)$/)
			if (aliasMatch?.[1]) {
				aliases.push(unquoteYamlScalar(aliasMatch[1].trim()))
			}
		}
	}

	return {
		description,
		aliases: [...new Set(aliases.filter(Boolean))],
	}
}

function unquoteYamlScalar(value: string) {
	return value
		.replace(/^[']|[']$/g, '')
		.replace(/^[\"]|[\"]$/g, '')
		.trim()
}

function rewriteDictionaryLinks(
	markdown: string,
	slugByReadmeAnchor: Map<string, string>,
) {
	return markdown.replace(/\]\(#([^)]+)\)/g, (match, anchor) => {
		const slug = slugByReadmeAnchor.get(anchor)

		return slug ? `](/ai-coding-dictionary/${slug})` : match
	})
}

function cleanSectionTitle(title: string) {
	return title.replace(/^Section\s+\d+\s+[-\u2014]\s+/, '').trim()
}

function parseDictionaryReadme(
	readme: string,
	frontmatterByPath: Map<string, DictionaryFrontmatter>,
	updatedAt: string,
): DictionaryData {
	const sectionStart = readme.search(/^## Section \d+/m)
	const content = sectionStart >= 0 ? readme.slice(sectionStart) : readme
	const lines = content.split('\n')
	const sections: { title: string; entries: DictionaryEntry[] }[] = []
	const entries: DictionaryEntry[] = []
	const slugByReadmeAnchor = new Map<string, string>()
	let currentSection: { title: string; entries: DictionaryEntry[] } | null =
		null
	let currentEntry: (DictionaryEntry & { bodyLines: string[] }) | null = null

	function finishEntry() {
		if (!currentEntry) return

		const rawBody = currentEntry.bodyLines.join('\n').trim()
		const frontmatter = frontmatterByPath.get(currentEntry.path) ?? {
			description: '',
			aliases: [],
		}
		currentEntry.rawBody = rawBody
		currentEntry.body = rewriteDictionaryLinks(rawBody, slugByReadmeAnchor)
		currentEntry.description =
			frontmatter.description || getDescription(rawBody)
		currentEntry.aliases = frontmatter.aliases
		delete (currentEntry as Partial<typeof currentEntry>).bodyLines
		entries.push(currentEntry)
		currentSection?.entries.push(currentEntry)
		currentEntry = null
	}

	for (const line of lines) {
		const sectionMatch = line.match(/^##\s+(Section\s+\d+.+)$/)
		if (sectionMatch?.[1]) {
			finishEntry()
			currentSection = {
				title: cleanSectionTitle(sectionMatch[1]),
				entries: [],
			}
			sections.push(currentSection)
			continue
		}

		const entryMatch = line.match(/^###\s+(.+)$/)
		if (entryMatch?.[1] && currentSection) {
			finishEntry()
			const title = entryMatch[1]
			const slug = slugFromTitle(title)
			const path = titleToDictionaryPath(title)
			slugByReadmeAnchor.set(anchorFromTitle(title), slug)
			currentEntry = {
				title,
				slug,
				path,
				githubUrl: titleToGithubUrl(title),
				description: '',
				aliases: [],
				body: '',
				rawBody: '',
				sectionTitle: currentSection.title,
				position: currentSection.entries.length,
				bodyLines: [],
			}
			continue
		}

		currentEntry?.bodyLines.push(line)
	}

	finishEntry()

	for (const entry of entries) {
		entry.body = rewriteDictionaryLinks(entry.rawBody, slugByReadmeAnchor)
	}

	return {
		sections,
		entries,
		sourceUrl: AI_CODING_DICTIONARY_SOURCE_URL,
		updatedAt,
	}
}

async function loadDictionary(): Promise<DictionaryData> {
	const [readme, frontmatterByPath, refUpdatedAt] = await Promise.all([
		getReadmeMarkdown(),
		getDictionarySourceFrontmatter(),
		getDictionaryRefUpdatedAt(),
	])

	return parseDictionaryReadme(
		readme,
		frontmatterByPath,
		refUpdatedAt ?? '1970-01-01T00:00:00.000Z',
	)
}

export const getAiCodingDictionary = unstable_cache(
	loadDictionary,
	['ai-coding-dictionary-github-readme-v1'],
	{
		revalidate: DICTIONARY_REVALIDATE_SECONDS,
		tags: ['ai-coding-dictionary'],
	},
)

export async function getAiCodingDictionaryEntry(slug: string) {
	const dictionary = await getAiCodingDictionary()
	return dictionary.entries.find((entry) => entry.slug === slug) ?? null
}
