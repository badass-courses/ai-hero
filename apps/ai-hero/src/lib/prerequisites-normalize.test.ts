import { createProcessor } from '@mdx-js/mdx'
import { describe, expect, it } from 'vitest'

import { extractMarkdownHeadings } from '@/utils/extract-markdown-headings'

import { parseLessonUrl, remarkPrerequisites } from './prerequisites-normalize'

function transform(source: string) {
	const tree = createProcessor().parse(source) as any
	remarkPrerequisites()(tree)
	return tree
}

const block = (tree: any) =>
	tree.children.find((node: any) => node.name === 'Prerequisites')

const href = (node: any) =>
	node.attributes.find((a: any) => a.name === 'href')?.value

const text = (node: any): string =>
	typeof node.value === 'string'
		? node.value
		: (node.children ?? []).map(text).join('')

describe('remarkPrerequisites', () => {
	it('unwraps a reason written on its own line', () => {
		const tree = transform(`<Prerequisites title="Crash Course Prerequisites">
	<Prerequisite href="https://www.aihero.dev/workshops/mod/a">
		What a spec made by \`/to-spec\` contains.
	</Prerequisite>
</Prerequisites>
`)
		const [item] = block(tree).children
		expect(item.name).toBe('Prerequisite')
		expect(href(item)).toBe('https://www.aihero.dev/workshops/mod/a')
		expect(item.children.map((n: any) => n.type)).toEqual([
			'text',
			'inlineCode',
			'text',
		])
	})

	it('accepts one-line items, which MDX wraps in a paragraph', () => {
		const tree = transform(`<Prerequisites>

<Prerequisite href="/workshops/mod/a">Reason A.</Prerequisite>
<Prerequisite href="/workshops/mod/b">Reason B.</Prerequisite>

</Prerequisites>
`)
		const items = block(tree).children
		expect(items.map((n: any) => n.name)).toEqual([
			'Prerequisite',
			'Prerequisite',
		])
		expect(items.map(href)).toEqual(['/workshops/mod/a', '/workshops/mod/b'])
		expect(items.map(text)).toEqual(['Reason A.', 'Reason B.'])
	})

	it('reduces a link inside a reason to its text', () => {
		const tree = transform(`<Prerequisites>
	<Prerequisite href="/workshops/mod/a">
		Read [the docs](https://example.com) first.
	</Prerequisite>
</Prerequisites>
`)
		const [item] = block(tree).children
		expect(JSON.stringify(item)).not.toContain('"link"')
		expect(text(item)).toBe('Read the docs first.')
	})

	it('drops stray content between items', () => {
		const tree = transform(`<Prerequisites>

Watch these first:

<Prerequisite href="/workshops/mod/a">Reason A.</Prerequisite>

</Prerequisites>
`)
		expect(block(tree).children).toHaveLength(1)
	})

	it('leaves everything outside the block alone', () => {
		const source = '## Prerequisites\n\n- [A](/workshops/mod/a): Reason.\n'
		const tree = transform(source)
		expect(tree.children.map((n: any) => n.type)).toEqual(['heading', 'list'])
	})
})

describe('parseLessonUrl', () => {
	it.each([
		['https://www.aihero.dev/workshops/mod/a', { module: 'mod', lesson: 'a' }],
		['https://aihero.dev/workshops/mod/a/', { module: 'mod', lesson: 'a' }],
		['/workshops/mod/a?t=30#setup', { module: 'mod', lesson: 'a' }],
		['https://example.com/workshops/mod/a', null],
		['/workshops/mod', null],
		['/posts/a', null],
		[undefined, null],
	])('%s', (url, expected) => {
		expect(parseLessonUrl(url)).toEqual(expected)
	})
})

describe('table of contents', () => {
	it('lists the block by its title, and skips one shown in a code fence', () => {
		const headings = extractMarkdownHeadings(`## Intro

<Prerequisites title="Crash Course Prerequisites">
	<Prerequisite href="/workshops/mod/a">Reason.</Prerequisite>
</Prerequisites>

\`\`\`mdx
<Prerequisites title="In A Fence"></Prerequisites>
\`\`\`

<Prerequisites>
	<Prerequisite href="/workshops/mod/b">Reason.</Prerequisite>
</Prerequisites>
`)
		expect(headings.map((h) => [h.level, h.slug])).toEqual([
			[2, 'intro'],
			[2, 'crash-course-prerequisites'],
			[2, 'prerequisites'],
		])
	})
})
