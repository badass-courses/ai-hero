import { cache } from 'react'
import { fetchGithubMarkdownFile } from '@/lib/github-markdown'
import { metaDescription } from '@/lib/meta-description'
import { slugifyHeading } from '@/utils/extract-markdown-headings'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified } from 'unified'

/**
 * Sandcastle's docs are its README: one long file on GitHub, which this module
 * splits into a page per `##` section so /sandcastle reads like a docs site
 * while the repo stays the only place the docs are written. The landing page's
 * facts (the lead, the three steps, the provider table, the example) come out
 * of the same parse, so it cannot drift from the docs either.
 *
 * Fetched from the raw host on ISR. A push to the README revalidates at once
 * through the github-source webhook; the hourly ISR window is the backstop.
 */
export const SANDCASTLE_OWNER = 'mattpocock'
export const SANDCASTLE_REPO = 'sandcastle'
const SANDCASTLE_REF = 'main'
const SANDCASTLE_README = 'README.md'

export const SANDCASTLE_DOCS_REVALIDATE_SECONDS = 3600
export const SANDCASTLE_DOCS_CACHE_TAG = 'sandcastle-docs'
export const SANDCASTLE_DOCS_PATH = '/sandcastle'
/** `owner/repo`, as GitHub names it in a push payload. */
export const SANDCASTLE_REPOSITORY = `${SANDCASTLE_OWNER}/${SANDCASTLE_REPO}`
export const SANDCASTLE_REPO_URL = `https://github.com/${SANDCASTLE_REPOSITORY}`
export const SANDCASTLE_README_URL = `${SANDCASTLE_REPO_URL}/blob/${SANDCASTLE_REF}/${SANDCASTLE_README}`
export const SANDCASTLE_PACKAGE = '@ai-hero/sandcastle'

/**
 * The sidebar's grouping, by page slug. Editorial, so it lives here rather than
 * in the README; a section the README gains later lands in "More" until it is
 * filed, rather than disappearing.
 */
const SANDCASTLE_DOCS_GROUPS: { title: string; slugs: string[] }[] = [
	{
		title: 'Guides',
		slugs: ['how-it-works', 'sandbox-providers', 'prompts', 'configuration'],
	},
	{
		title: 'Reference',
		slugs: ['api', 'cli-commands', 'custom-sandbox-providers'],
	},
]
const UNFILED_GROUP = 'More'
/**
 * Sections about the repo rather than about using Sandcastle: how to work on
 * it, and its license. They stay README-only, links to them open the README,
 * and the landing page names both in its closing line.
 */
const LICENSE_SECTION = 'license'
const README_ONLY_SECTIONS = ['development', LICENSE_SECTION]

/**
 * The README's first sections are each a few lines long, and a newcomer reads
 * them in one go, so they make one page that keeps them as its sections.
 */
const SANDCASTLE_DOCS_START = {
	title: 'Getting started',
	slug: 'getting-started',
	group: 'Start here',
	sections: ['what-is-sandcastle', 'prerequisites', 'quick-start'],
}

export type SandcastleDocsPage = {
	title: string
	slug: string
	href: string
	group: string
	/** The section's opening paragraph as plain text, for meta and the index. */
	description: string
	/** Section body as markdown, headings promoted one level and links rewritten. */
	body: string
}

export type SandcastleProvider = {
	name: string
	importPath: string
	type: string
}

export type SandcastleDocs = {
	/** Pages in sidebar order: the start page, then grouped in README order. */
	pages: SandcastleDocsPage[]
	/** The opening sections as one page, which the sidebar puts first. */
	start: SandcastleDocsPage | null
	groups: { title: string; pages: SandcastleDocsPage[] }[]
	/** The README's opening sentence. */
	lead: string
	/** The intro's numbered list, as inline markdown. */
	steps: string[]
	providers: SandcastleProvider[]
	/** The first TypeScript block in Quick start. */
	example: string | null
	/** The README's License section, as text. */
	license: string | null
}

type MdNode = {
	type: string
	depth?: number
	url?: string
	value?: string
	lang?: string | null
	ordered?: boolean | null
	children?: MdNode[]
	position?: { start: { offset?: number }; end: { offset?: number } }
}

type Edit = { start: number; end: number; text: string }

const parser = unified().use(remarkParse).use(remarkGfm)

function plainText(node: MdNode): string {
	if (node.value !== undefined) return node.value
	return (node.children ?? []).map(plainText).join('')
}

/**
 * The anchor GitHub gives a README heading, which is what the README's own
 * `#links` point at. github-slugger's rule: lowercase, drop punctuation, one
 * hyphen per space.
 */
function githubAnchor(text: string) {
	return text
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\s_-]/gu, '')
		.replace(/ /g, '-')
}

function walk(node: MdNode, visit: (node: MdNode) => void) {
	visit(node)
	node.children?.forEach((child) => walk(child, visit))
}

function offsets(node: MdNode) {
	return {
		start: node.position?.start.offset ?? 0,
		end: node.position?.end.offset ?? 0,
	}
}

function applyEdits(source: string, edits: Edit[], from: number, to: number) {
	let result = ''
	let cursor = from
	for (const edit of edits) {
		if (edit.start < from || edit.end > to) continue
		result += source.slice(cursor, edit.start) + edit.text
		cursor = edit.end
	}
	return result + source.slice(cursor, to)
}

function isRepoRelative(url: string) {
	return !/^([a-z][a-z0-9+.-]*:|#|\/)/i.test(url)
}

function introText(node: MdNode | undefined) {
	// An intro often leads into a list ("…in isolated sandboxes:"), which reads
	// as cut off once it stands alone.
	return node ? plainText(node).replace(/:$/, '.') : ''
}

/** A section's opening sentence: what the docs index shows under its title. */
function firstSentence(text: string) {
	return text.match(/^.+?[.!?](?=\s|$)/)?.[0] ?? text
}

function findFirst(nodes: MdNode[], match: (node: MdNode) => boolean) {
	let found: MdNode | undefined
	for (const node of nodes) {
		walk(node, (child) => {
			if (!found && match(child)) found = child
		})
	}
	return found
}

function providerRows(table: MdNode | undefined): SandcastleProvider[] {
	const [header, ...rows] = (table?.children ?? []).map((row) =>
		(row.children ?? []).map((cell) => plainText(cell).trim()),
	)
	const column = (name: string) =>
		header?.findIndex((cell) => cell.toLowerCase() === name) ?? -1
	const [name, importPath, type] = ['provider', 'import path', 'type'].map(
		column,
	)
	if (name! < 0 || importPath! < 0 || type! < 0) return []
	return rows.map((cells) => ({
		name: cells[name!] ?? '',
		importPath: cells[importPath!] ?? '',
		type: cells[type!] ?? '',
	}))
}

/**
 * Split the README into pages. Anything before the first `##` is the
 * README's logo block, which the landing page's wordmark replaces.
 */
export function parseSandcastleReadme(readme: string): SandcastleDocs {
	const root = parser.parse(readme) as MdNode
	const blocks = root.children ?? []
	const sections = blocks
		.map((node, index) => ({ node, index }))
		.filter(({ node }) => node.type === 'heading' && node.depth === 2)

	const startHref = `${SANDCASTLE_DOCS_PATH}/${SANDCASTLE_DOCS_START.slug}`

	// Every heading's GitHub anchor → where it lives on this site.
	const anchors = new Map<string, string>()
	const sectionBlocks = sections.map(({ node, index }, position) => {
		const title = plainText(node)
		const slug = slugifyHeading(title)
		const isStart = SANDCASTLE_DOCS_START.sections.includes(slug)
		const isReadmeOnly = README_ONLY_SECTIONS.includes(slug)
		const href = isReadmeOnly
			? `${SANDCASTLE_README_URL}#${githubAnchor(title)}`
			: isStart
				? startHref
				: `${SANDCASTLE_DOCS_PATH}/${slug}`
		const nextIndex = sections[position + 1]?.index ?? blocks.length
		const body = blocks.slice(index + 1, nextIndex)
		anchors.set(githubAnchor(title), isStart ? `${href}#${slug}` : href)
		for (const block of body) {
			walk(block, (child) => {
				if (child.type !== 'heading') return
				const text = plainText(child)
				anchors.set(
					githubAnchor(text),
					isReadmeOnly
						? `${SANDCASTLE_README_URL}#${githubAnchor(text)}`
						: `${href}#${slugifyHeading(text)}`,
				)
			})
		}
		const group =
			SANDCASTLE_DOCS_GROUPS.find((candidate) => candidate.slugs.includes(slug))
				?.title ?? UNFILED_GROUP
		return {
			title,
			slug,
			href,
			group,
			isStart,
			isReadmeOnly,
			heading: node,
			blocks: body,
		}
	})
	// The start page keeps its sections' own headings, so they stay unpromoted.
	const startRanges = sectionBlocks
		.filter((section) => section.isStart)
		.map(({ heading, blocks: body }) => ({
			start: offsets(heading).start,
			end: offsets(body[body.length - 1] ?? heading).end,
		}))
	const inStart = (at: number) =>
		startRanges.some((range) => at >= range.start && at < range.end)

	const edits: Edit[] = []
	walk(root, (node) => {
		const { start, end } = offsets(node)
		if (
			node.type === 'heading' &&
			(node.depth ?? 0) > 2 &&
			readme[start] === '#' &&
			!inStart(start)
		) {
			// `###` becomes `##`: the README's `##` is the page's `h1`.
			edits.push({ start, end: start + 1, text: '' })
		}
		if (node.type === 'text' || node.type === 'html') {
			// The README is markdown, the page compiles it as MDX: a bare
			// `Record<string, string>` in a table cell would parse as JSX and drop
			// the whole page to the unhighlighted fallback. Escaped, it is text.
			for (let at = start; at < end; at++) {
				if ('<{}'.includes(readme[at]!) && readme[at - 1] !== '\\') {
					edits.push({ start: at, end: at, text: '\\' })
				}
			}
		}
		if (node.type === 'link' && node.url) {
			const target = node.url.startsWith('#')
				? anchors.get(node.url.slice(1))
				: isRepoRelative(node.url)
					? `${SANDCASTLE_REPO_URL}/blob/${SANDCASTLE_REF}/${node.url.replace(/^\.\//, '')}`
					: null
			const source = readme.slice(start, end)
			const urlAt = source.lastIndexOf(`(${node.url}`)
			if (target && urlAt >= 0) {
				const urlStart = start + urlAt + 1
				edits.push({
					start: urlStart,
					end: urlStart + node.url.length,
					text: target,
				})
			}
		}
	})
	edits.sort((a, b) => a.start - b.start)

	const sourceOf = (nodes: MdNode[]) => {
		const first = nodes[0]
		const last = nodes[nodes.length - 1]
		return first && last
			? applyEdits(readme, edits, offsets(first).start, offsets(last).end)
			: ''
	}

	const describe = (body: MdNode[]) =>
		metaDescription(
			firstSentence(
				introText(body.find((block) => block.type === 'paragraph')),
			),
		) ?? ''

	const startSections = sectionBlocks.filter((section) => section.isStart)
	const start: SandcastleDocsPage | null =
		startSections.length > 0
			? {
					title: SANDCASTLE_DOCS_START.title,
					slug: SANDCASTLE_DOCS_START.slug,
					href: startHref,
					group: SANDCASTLE_DOCS_START.group,
					description: describe(startSections[0]!.blocks),
					body: startSections
						.map(({ heading, blocks: body }) => sourceOf([heading, ...body]))
						.join('\n\n'),
				}
			: null
	const pages = sectionBlocks
		.filter((section) => !section.isStart && !section.isReadmeOnly)
		.map(({ title, slug, href, group, blocks: body }) => ({
			title,
			slug,
			href,
			group,
			description: describe(body),
			body: sourceOf(body),
		}))
	const groups = [
		...SANDCASTLE_DOCS_GROUPS.map(({ title }) => title),
		UNFILED_GROUP,
	]
		.map((title) => ({
			title,
			pages: pages.filter((page) => page.group === title),
		}))
		.filter((group) => group.pages.length > 0)

	const intro = sectionBlocks[0]?.blocks ?? []
	const steps = intro.find((block) => block.type === 'list' && block.ordered)
	const blocksOf = (slug: string) =>
		sectionBlocks.find((section) => section.slug === slug)?.blocks ?? []

	return {
		pages: [
			...(start ? [start] : []),
			...groups.flatMap((group) => group.pages),
		],
		start,
		groups,
		lead: introText(intro.find((block) => block.type === 'paragraph')),
		steps: (steps?.children ?? []).map((item) => sourceOf(item.children ?? [])),
		providers: providerRows(
			findFirst(blocksOf('sandbox-providers'), (node) => node.type === 'table'),
		),
		example:
			findFirst(
				blocksOf('quick-start'),
				(node) =>
					node.type === 'code' &&
					['ts', 'typescript'].includes(node.lang ?? ''),
			)?.value ?? null,
		license:
			introText(
				blocksOf(LICENSE_SECTION).find((block) => block.type === 'paragraph'),
			) || null,
	}
}

export const getSandcastleDocs = cache(async () => {
	const readme = await fetchGithubMarkdownFile({
		owner: SANDCASTLE_OWNER,
		repo: SANDCASTLE_REPO,
		path: SANDCASTLE_README,
		ref: SANDCASTLE_REF,
		revalidate: SANDCASTLE_DOCS_REVALIDATE_SECONDS,
		tags: [SANDCASTLE_DOCS_CACHE_TAG],
		transport: 'raw-only',
	})
	return parseSandcastleReadme(readme)
})

export async function getSandcastleDocsPage(slug: string) {
	const docs = await getSandcastleDocs()
	const { pages } = docs
	const index = pages.findIndex((page) => page.slug === slug)
	if (index < 0) return null
	return {
		docs,
		page: pages[index]!,
		previous: pages[index - 1] ?? null,
		next: pages[index + 1] ?? null,
	}
}

/**
 * Last week's npm downloads, the number Sandcastle is usually described by.
 * Null when the registry does not answer, so the stat drops out rather than
 * printing a zero.
 */
export async function getSandcastleWeeklyDownloads(): Promise<number | null> {
	try {
		const response = await fetch(
			`https://api.npmjs.org/downloads/point/last-week/${SANDCASTLE_PACKAGE}`,
			{ next: { revalidate: SANDCASTLE_DOCS_REVALIDATE_SECONDS } },
		)
		if (!response.ok) return null
		const { downloads } = (await response.json()) as { downloads?: unknown }
		return typeof downloads === 'number' ? downloads : null
	} catch {
		return null
	}
}
