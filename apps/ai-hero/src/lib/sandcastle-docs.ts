import { posix } from 'node:path'
import { cache } from 'react'
import { fetchGithubMarkdownFile } from '@/lib/github-markdown'
import { metaDescription } from '@/lib/meta-description'
import { slugifyHeading } from '@/utils/extract-markdown-headings'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified } from 'unified'

/**
 * Sandcastle's docs live in its repo, and /sandcastle renders them, so the
 * repo stays the only place they are written. `docs/guide/toc.json` lists the
 * pages (`docs/guide/<slug>.md`) and groups them for the sidebar. The landing
 * page's facts (the lead, the three steps, the provider table, the example)
 * come out of the same pages, so it cannot drift from the docs either.
 *
 * Until the repo has `toc.json`, the docs are still one README, split here
 * into a page per `##` section. That path goes once the split lands upstream.
 *
 * Fetched from the raw host on ISR. A push to the docs revalidates at once
 * through the github-source webhook; the hourly ISR window is the backstop.
 */
export const SANDCASTLE_OWNER = 'mattpocock'
export const SANDCASTLE_REPO = 'sandcastle'
const SANDCASTLE_REF = 'main'
const SANDCASTLE_README = 'README.md'
export const SANDCASTLE_GUIDE_DIR = 'docs/guide'
const SANDCASTLE_TOC = `${SANDCASTLE_GUIDE_DIR}/toc.json`

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
 * it, and its license. They stay README-only and links to them open the
 * README; the landing page closes on the license.
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
	/** Section body as MDX source, headings promoted one level and links rewritten. */
	body: string
	/** The same body as plain markdown, for the page's `.md` twin. */
	markdown: string
	/** The file on GitHub the page is written in, for "Edit this page". */
	sourceUrl: string
}

/**
 * `docs/guide/toc.json`: the page a new reader opens first, then the sidebar's
 * groups, each a title and its pages by slug (`docs/guide/<slug>.md`).
 */
export type SandcastleToc = {
	start: string
	groups: { title: string; pages: string[] }[]
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

/** `mdx`: an escape only the MDX compile needs, left out of plain markdown. */
type Edit = { start: number; end: number; text: string; mdx?: boolean }

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

/**
 * The docs are markdown, the page compiles them as MDX: a bare
 * `Record<string, string>` in a table cell would parse as JSX and drop the
 * whole page to the unhighlighted fallback. Escaped, it is text.
 */
function mdxEscapes(source: string, node: MdNode): Edit[] {
	if (node.type !== 'text' && node.type !== 'html') return []
	const { start, end } = offsets(node)
	const edits: Edit[] = []
	for (let at = start; at < end; at++) {
		if ('<{}'.includes(source[at]!) && source[at - 1] !== '\\') {
			edits.push({ start: at, end: at, text: '\\', mdx: true })
		}
	}
	return edits
}

/** Point a link node at `target`, editing only its URL. */
function linkEdit(source: string, node: MdNode, target: string): Edit | null {
	const { start, end } = offsets(node)
	const urlAt = source.slice(start, end).lastIndexOf(`(${node.url}`)
	if (urlAt < 0) return null
	const urlStart = start + urlAt + 1
	return {
		start: urlStart,
		end: urlStart + (node.url?.length ?? 0),
		text: target,
	}
}

/** Slices of `source` with `edits` applied, plain or MDX-escaped. */
function sourceSlicer(source: string, edits: Edit[]) {
	edits.sort((a, b) => a.start - b.start)
	const markdownEdits = edits.filter((edit) => !edit.mdx)
	return (nodes: MdNode[], { mdx = true } = {}) => {
		const first = nodes[0]
		const last = nodes[nodes.length - 1]
		return first && last
			? applyEdits(
					source,
					mdx ? edits : markdownEdits,
					offsets(first).start,
					offsets(last).end,
				)
			: ''
	}
}

function describe(body: MdNode[]) {
	return (
		metaDescription(
			firstSentence(
				introText(body.find((block) => block.type === 'paragraph')),
			),
		) ?? ''
	)
}

/** The provider table: the first one with these columns, wherever it sits. */
function findProviders(blocks: MdNode[]) {
	let providers: SandcastleProvider[] = []
	for (const block of blocks) {
		walk(block, (node) => {
			if (providers.length === 0 && node.type === 'table') {
				providers = providerRows(node)
			}
		})
	}
	return providers
}

function firstTypeScript(blocks: MdNode[]) {
	return (
		findFirst(
			blocks,
			(node) =>
				node.type === 'code' && ['ts', 'typescript'].includes(node.lang ?? ''),
		)?.value ?? null
	)
}

function introText(node: MdNode | undefined) {
	// An intro often leads into a list ("…in isolated sandboxes:"), which reads
	// as cut off once it stands alone.
	return node ? plainText(node).replace(/:$/, '.') : ''
}

/**
 * The README titles some sections in Title Case ("Sandbox Providers") and
 * others in sentence case ("How it works"). The sidebar uses sentence case
 * throughout, keeping acronyms, code-cased words and the tool's own name.
 */
function sentenceCase(title: string) {
	return title
		.split(' ')
		.map((word, index) =>
			index > 0 && /^[A-Z][a-z]+$/.test(word) && word !== 'Sandcastle'
				? word.toLowerCase()
				: word,
		)
		.join(' ')
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

	// Every heading's GitHub anchor → where it lives on this site. GitHub
	// numbers a repeated heading (`options`, `options-1`); the site's ids do
	// not, so a repeat lands on the page's first heading of that name.
	const anchors = new Map<string, string>()
	const anchorCounts = new Map<string, number>()
	const setAnchor = (text: string, target: string) => {
		const base = githubAnchor(text)
		const count = anchorCounts.get(base) ?? 0
		anchorCounts.set(base, count + 1)
		anchors.set(count === 0 ? base : `${base}-${count}`, target)
	}
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
		setAnchor(title, isStart ? `${href}#${slug}` : href)
		for (const block of body) {
			walk(block, (child) => {
				if (child.type !== 'heading') return
				const text = plainText(child)
				setAnchor(
					text,
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
		const { start } = offsets(node)
		if (
			node.type === 'heading' &&
			(node.depth ?? 0) > 2 &&
			readme[start] === '#' &&
			!inStart(start)
		) {
			// `###` becomes `##`: the README's `##` is the page's `h1`.
			edits.push({ start, end: start + 1, text: '' })
		}
		edits.push(...mdxEscapes(readme, node))
		if (node.type === 'link' && node.url) {
			const target = node.url.startsWith('#')
				? anchors.get(node.url.slice(1))
				: isRepoRelative(node.url)
					? `${SANDCASTLE_REPO_URL}/blob/${SANDCASTLE_REF}/${node.url.replace(/^\.\//, '')}`
					: null
			const edit = target ? linkEdit(readme, node, target) : null
			if (edit) edits.push(edit)
		}
	})
	const sourceOf = sourceSlicer(readme, edits)

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
					markdown: startSections
						.map(({ heading, blocks: body }) =>
							sourceOf([heading, ...body], { mdx: false }),
						)
						.join('\n\n'),
					sourceUrl: SANDCASTLE_README_URL,
				}
			: null
	const pages = sectionBlocks
		.filter((section) => !section.isStart && !section.isReadmeOnly)
		.map(({ title, slug, href, group, blocks: body }) => ({
			title: sentenceCase(title),
			slug,
			href,
			group,
			description: describe(body),
			body: sourceOf(body),
			markdown: sourceOf(body, { mdx: false }),
			sourceUrl: SANDCASTLE_README_URL,
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
		providers: findProviders(blocksOf('sandbox-providers')),
		example: firstTypeScript(blocksOf('quick-start')),
		license:
			introText(
				blocksOf(LICENSE_SECTION).find((block) => block.type === 'paragraph'),
			) || null,
	}
}

/** The README's License section, which the landing page closes on. */
function readmeLicense(readme: string) {
	const blocks = (parser.parse(readme) as MdNode).children ?? []
	const heading = blocks.findIndex(
		(node) =>
			node.type === 'heading' &&
			node.depth === 2 &&
			slugifyHeading(plainText(node)) === LICENSE_SECTION,
	)
	const paragraph = heading < 0 ? undefined : blocks[heading + 1]
	return paragraph?.type === 'paragraph' ? introText(paragraph) || null : null
}

/**
 * Build the docs from `docs/guide`: one page per `toc.json` slug, in its
 * order. A page's `# Title` is its title; the rest is its body. Links between
 * pages become site links, other repo-relative links open on GitHub.
 */
export function parseSandcastleGuide({
	toc,
	files,
	readme,
}: {
	toc: SandcastleToc
	/** Each listed page's markdown, by slug. */
	files: Record<string, string>
	readme: string
}): SandcastleDocs {
	const groupOf = new Map(
		toc.groups.flatMap((group) =>
			group.pages.map((slug) => [slug, group.title] as const),
		),
	)
	const parsed = [toc.start, ...groupOf.keys()].map((slug) => {
		const source = files[slug] ?? ''
		const root = parser.parse(source) as MdNode
		const [first, ...rest] = root.children ?? []
		const hasTitle = first?.type === 'heading' && first.depth === 1
		return {
			slug,
			source,
			root,
			file: `${SANDCASTLE_GUIDE_DIR}/${slug}.md`,
			href: `${SANDCASTLE_DOCS_PATH}/${slug}`,
			title: hasTitle ? plainText(first) : slug,
			blocks: hasTitle ? rest : (root.children ?? []),
		}
	})

	// `<repo path>#<GitHub anchor>` → where it lives on this site. GitHub
	// numbers a repeated heading (`options`, `options-1`); the site's ids do
	// not, so a repeat lands on the page's first heading of that name.
	const anchors = new Map<string, string>()
	for (const page of parsed) {
		anchors.set(page.file, page.href)
		const counts = new Map<string, number>()
		for (const block of page.blocks) {
			walk(block, (node) => {
				if (node.type !== 'heading') return
				const text = plainText(node)
				const base = githubAnchor(text)
				const count = counts.get(base) ?? 0
				counts.set(base, count + 1)
				anchors.set(
					`${page.file}#${count === 0 ? base : `${base}-${count}`}`,
					`${page.href}#${slugifyHeading(text)}`,
				)
			})
		}
	}
	const resolveLink = (url: string, fromFile: string) => {
		if (!url.startsWith('#') && !isRepoRelative(url)) return null
		const [path = '', hash] = url.split('#')
		const file = path
			? posix.normalize(posix.join(posix.dirname(fromFile), path))
			: fromFile
		return (
			anchors.get(hash ? `${file}#${hash}` : file) ??
			anchors.get(file) ??
			`${SANDCASTLE_REPO_URL}/blob/${SANDCASTLE_REF}/${file}${hash ? `#${hash}` : ''}`
		)
	}

	const pages = parsed.map((page) => {
		const edits: Edit[] = []
		walk(page.root, (node) => {
			edits.push(...mdxEscapes(page.source, node))
			if (node.type === 'link' && node.url) {
				const target = resolveLink(node.url, page.file)
				const edit = target ? linkEdit(page.source, node, target) : null
				if (edit) edits.push(edit)
			}
		})
		const sourceOf = sourceSlicer(page.source, edits)
		return {
			...page,
			sourceOf,
			page: {
				title: page.title,
				slug: page.slug,
				href: page.href,
				group:
					page.slug === toc.start
						? SANDCASTLE_DOCS_START.group
						: (groupOf.get(page.slug) ?? UNFILED_GROUP),
				description: describe(page.blocks),
				body: sourceOf(page.blocks),
				markdown: sourceOf(page.blocks, { mdx: false }),
				sourceUrl: `${SANDCASTLE_REPO_URL}/blob/${SANDCASTLE_REF}/${page.file}`,
			} satisfies SandcastleDocsPage,
		}
	})

	const [start] = pages
	const steps = start?.blocks.find(
		(block) => block.type === 'list' && block.ordered,
	)
	return {
		pages: pages.map(({ page }) => page),
		start: start?.page ?? null,
		groups: toc.groups
			.map((group) => ({
				title: group.title,
				pages: pages
					.filter(({ slug }) => group.pages.includes(slug))
					.map(({ page }) => page),
			}))
			.filter((group) => group.pages.length > 0),
		lead: introText(start?.blocks.find((block) => block.type === 'paragraph')),
		steps: (steps?.children ?? []).map(
			(item) => start?.sourceOf(item.children ?? []) ?? '',
		),
		providers: findProviders(pages.flatMap(({ blocks }) => blocks)),
		example: firstTypeScript(start?.blocks ?? []),
		license: readmeLicense(readme),
	}
}

function fetchRepoFile(path: string) {
	return fetchGithubMarkdownFile({
		owner: SANDCASTLE_OWNER,
		repo: SANDCASTLE_REPO,
		path,
		ref: SANDCASTLE_REF,
		revalidate: SANDCASTLE_DOCS_REVALIDATE_SECONDS,
		tags: [SANDCASTLE_DOCS_CACHE_TAG],
		transport: 'raw-only',
	})
}

/** `toc.json`, or null while the repo has none. Any other failure throws. */
async function fetchToc(): Promise<SandcastleToc | null> {
	try {
		return JSON.parse(await fetchRepoFile(SANDCASTLE_TOC)) as SandcastleToc
	} catch (error) {
		if ((error as { status?: number }).status === 404) return null
		throw error
	}
}

export const getSandcastleDocs = cache(async () => {
	const [readme, toc] = await Promise.all([
		fetchRepoFile(SANDCASTLE_README),
		fetchToc(),
	])
	if (!toc) return parseSandcastleReadme(readme)

	const slugs = [toc.start, ...toc.groups.flatMap((group) => group.pages)]
	const pages = await Promise.all(
		slugs.map((slug) => fetchRepoFile(`${SANDCASTLE_GUIDE_DIR}/${slug}.md`)),
	)
	return parseSandcastleGuide({
		toc,
		files: Object.fromEntries(
			slugs.map((slug, index) => [slug, pages[index]!]),
		),
		readme,
	})
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

/** Site links in the markdown twins become absolute, for a reader off-site. */
function absoluteLinks(markdown: string, baseUrl: string) {
	return markdown.replace(/\]\(\//g, `](${baseUrl}/`)
}

/** One docs page as markdown: what "Copy page" copies and `.md` serves. */
export function sandcastlePageMarkdown(
	page: SandcastleDocsPage,
	baseUrl: string,
) {
	return `# ${page.title}

Sandcastle docs: ${baseUrl}${page.href}

${absoluteLinks(page.markdown, baseUrl)}
`
}

/** Every docs page in sidebar order, as one markdown file. */
export function sandcastleDocsMarkdown(docs: SandcastleDocs, baseUrl: string) {
	return `# Sandcastle

${docs.lead}

Install with \`npm install --save-dev ${SANDCASTLE_PACKAGE}\`. Source: ${SANDCASTLE_README_URL}

${docs.pages.map((page) => sandcastlePageMarkdown(page, baseUrl)).join('\n')}`
}
