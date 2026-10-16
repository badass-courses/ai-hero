import { convert } from 'html-to-text'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified } from 'unified'

const parser = unified().use(remarkParse).use(remarkGfm)

type TextNode = {
	type: string
	value?: string
	children?: TextNode[]
}

function plainText(node: TextNode): string {
	if (
		['image', 'imageReference', 'definition', 'footnoteDefinition'].includes(
			node.type,
		)
	)
		return ''
	if (node.type === 'html') {
		return convert(node.value ?? '', {
			wordwrap: false,
			selectors: [{ selector: 'a', options: { ignoreHref: true } }],
		})
	}
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

/** Decode and flatten Markdown/HTML before taking a whole-word prefix. The ellipsis counts toward the limit. */
export function metaDescription(source?: string | null, limit = 155): string {
	if (!Number.isInteger(limit) || limit < 0)
		throw new RangeError('Description limit must be a non-negative integer')
	if (limit === 0) return ''
	const text = plainText(parser.parse(source ?? ''))
		.replace(/\s+/g, ' ')
		.trim()
	if (text.length <= limit) return text
	const candidate = text.slice(0, limit - 1)
	// Keep the final word only when the next character is whitespace.
	const prefix = /\s/.test(text[limit - 1] ?? '')
		? candidate.trimEnd()
		: candidate.slice(0, Math.max(0, candidate.lastIndexOf(' '))).trimEnd()
	return `${prefix}…`
}
