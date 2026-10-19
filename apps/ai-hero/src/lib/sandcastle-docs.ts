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
 * while the repo stays the only place the docs are written.
 *
 * Fetched from the raw host on ISR, so a README push shows up within the hour
 * (or at once via `/api/revalidate?tag=sandcastle-docs`).
 */
const SANDCASTLE_OWNER = 'mattpocock'
const SANDCASTLE_REPO = 'sandcastle'
const SANDCASTLE_REF = 'main'
const SANDCASTLE_README = 'README.md'

export const SANDCASTLE_DOCS_REVALIDATE_SECONDS = 3600
export const SANDCASTLE_DOCS_CACHE_TAG = 'sandcastle-docs'
export const SANDCASTLE_DOCS_PATH = '/sandcastle'
export const SANDCASTLE_REPO_URL = `https://github.com/${SANDCASTLE_OWNER}/${SANDCASTLE_REPO}`
export const SANDCASTLE_README_URL = `${SANDCASTLE_REPO_URL}/blob/${SANDCASTLE_REF}/${SANDCASTLE_README}`
export const SANDCASTLE_PACKAGE = '@ai-hero/sandcastle'

export type SandcastleDocsHeading = {
	title: string
	/** The heading's id on the rendered page, as `Heading` mints it. */
	anchor: string
}

export type SandcastleDocsPage = {
	title: string
	/** Empty for the first section, which is the /sandcastle index. */
	slug: string
	href: string
	/** The section's opening paragraph as plain text, for meta and the sitemap. */
	description: string
	/** Section body as markdown, headings promoted one level and links rewritten. */
	body: string
	/** The page's `##` headings (the README's `###`), for the sidebar. */
	headings: SandcastleDocsHeading[]
}

type MdNode = {
	type: string
	depth?: number
	url?: string
	value?: string
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

/**
 * Split the README into pages. Anything before the first `##` is the
 * README's logo block, which the page chrome replaces.
 */
export function parseSandcastleReadme(readme: string): SandcastleDocsPage[] {
	const root = parser.parse(readme) as MdNode
	const blocks = root.children ?? []
	const sections = blocks
		.map((node, index) => ({ node, index }))
		.filter(({ node }) => node.type === 'heading' && node.depth === 2)

	// Every heading's GitHub anchor → where it lives on this site.
	const anchors = new Map<string, string>()
	const pages = sections.map(({ node, index }, position) => {
		const title = plainText(node)
		const slug = position === 0 ? '' : slugifyHeading(title)
		const href = slug ? `${SANDCASTLE_DOCS_PATH}/${slug}` : SANDCASTLE_DOCS_PATH
		const nextIndex = sections[position + 1]?.index ?? blocks.length
		const body = blocks.slice(index + 1, nextIndex)
		anchors.set(githubAnchor(title), href)

		const headings: SandcastleDocsHeading[] = []
		for (const block of body) {
			walk(block, (child) => {
				if (child.type !== 'heading') return
				const text = plainText(child)
				const anchor = slugifyHeading(text)
				anchors.set(githubAnchor(text), `${href}#${anchor}`)
				if (child.depth === 3) headings.push({ title: text, anchor })
			})
		}

		return { title, slug, href, blocks: body, headings }
	})

	const edits: Edit[] = []
	walk(root, (node) => {
		const { start, end } = offsets(node)
		if (
			node.type === 'heading' &&
			(node.depth ?? 0) > 2 &&
			readme[start] === '#'
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

	return pages.map(({ blocks, ...page }) => {
		const first = blocks[0]
		const last = blocks[blocks.length - 1]
		const intro = blocks.find((block) => block.type === 'paragraph')
		return {
			...page,
			// An intro often leads into a list ("…in isolated sandboxes:"), which
			// reads as cut off once it stands alone.
			description:
				(intro && metaDescription(plainText(intro).replace(/:$/, '.'))) ?? '',
			body:
				first && last
					? applyEdits(readme, edits, offsets(first).start, offsets(last).end)
					: '',
		}
	})
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
	const pages = await getSandcastleDocs()
	const index = pages.findIndex((page) => page.slug === slug)
	if (index < 0) return null
	return {
		pages,
		page: pages[index]!,
		previous: pages[index - 1] ?? null,
		next: pages[index + 1] ?? null,
	}
}
