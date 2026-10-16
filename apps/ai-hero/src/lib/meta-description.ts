import { convert } from 'html-to-text'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified } from 'unified'

const parser = unified().use(remarkParse).use(remarkGfm)

type TextNode = { type: string; value?: string; children?: TextNode[] }

function plainText(node: TextNode): string {
	if (
		['image', 'imageReference', 'definition', 'footnoteDefinition'].includes(
			node.type,
		)
	)
		return ''
	if (node.type === 'html')
		return convert(node.value ?? '', {
			wordwrap: false,
			selectors: [
				{ selector: 'a', options: { ignoreHref: true } },
				...['img', 'script', 'style'].map((selector) => ({
					selector,
					format: 'skip',
				})),
				...['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].map((selector) => ({
					selector,
					options: { uppercase: false },
				})),
			],
		})
	if (node.type === 'break') return ' '
	if (node.value !== undefined) return node.value
	const separator = [
		'root',
		'blockquote',
		'list',
		'listItem',
		'table',
		'tableRow',
	].includes(node.type)
		? ' '
		: ''
	return (node.children ?? []).map(plainText).join(separator)
}

/** Full plain text for content data. Never truncate the dictionary's on-page description. */
export function plainDescription(source?: string | null): string {
	// Inline raw-text elements can span several Markdown nodes. Remove them as a unit.
	const withoutRawElements = (source ?? '').replace(
		/<(script|style)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi,
		'',
	)
	return plainText(parser.parse(withoutRawElements)).replace(/\s+/g, ' ').trim()
}

/** Normalize once, then take a bounded prefix. Already-plain dictionary data must not be parsed again. */
export function metaDescription(
	source?: string | null,
	limit = 155,
	options: { plainText?: boolean } = {},
): string | undefined {
	if (!Number.isInteger(limit) || limit < 0)
		throw new RangeError('Description limit must be a non-negative integer')
	if (limit === 0) return undefined
	const text = options.plainText
		? (source?.trim() ?? '')
		: plainDescription(source)
	if (!text) return undefined
	if (text.length <= limit) return text
	const candidate = text.slice(0, limit - 1).replace(/[\uD800-\uDBFF]$/, '')
	const boundary = candidate.lastIndexOf(' ')
	const prefix = /\s/.test(text[limit - 1] ?? '')
		? candidate.trimEnd()
		: boundary > 0
			? candidate.slice(0, boundary)
			: candidate
	return `${prefix.replace(/[\s.,;:!?…\-–—]+$/, '')}…`
}
