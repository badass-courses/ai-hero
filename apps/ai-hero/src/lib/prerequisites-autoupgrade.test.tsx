import * as runtime from 'react/jsx-runtime'
import { evaluate } from '@mdx-js/mdx'
import { renderToStaticMarkup } from 'react-dom/server'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import { describe, expect, it } from 'vitest'

import { parseLessonUrl, remarkPrerequisites } from './prerequisites-autoupgrade'

const SAMPLE = `Intro paragraph.

## Crash Course Prerequisites

- [Sessions And The Context](https://www.aihero.dev/workshops/ai-coding-crash-course/sessions-and-the-context-241f60ee): What a session is, and why the review runs in a fresh one.
- [Write Great Specs With This Skill](https://www.aihero.dev/workshops/ai-coding-crash-course/write-great-specs-with-this-skill-362ad013): What a spec made by \`/to-spec\` contains, so you know what the code is reviewed against.

## Next Section

Body.
`

function transform(markdown: string) {
	const processor = unified().use(remarkParse).use(remarkGfm)
	const tree = processor.parse(markdown) as any
	remarkPrerequisites()(tree)
	return tree
}

const topLevel = (tree: any) =>
	tree.children.map((node: any) => node.name ?? node.type)

const attrs = (node: any) =>
	Object.fromEntries(
		node.attributes.map((a: any) => [a.name, a.value]),
	) as Record<string, string>

describe('remarkPrerequisites', () => {
	it('upgrades the real sample', () => {
		const tree = transform(SAMPLE)
		expect(topLevel(tree)).toEqual([
			'paragraph',
			'Prerequisites',
			'heading',
			'paragraph',
		])
		const block = tree.children[1]
		expect(attrs(block)).toEqual({
			title: 'Crash Course Prerequisites',
			level: '2',
		})
		expect(block.children.map(attrs)).toEqual([
			{
				module: 'ai-coding-crash-course',
				lesson: 'sessions-and-the-context-241f60ee',
				href: 'https://www.aihero.dev/workshops/ai-coding-crash-course/sessions-and-the-context-241f60ee',
				label: 'Sessions And The Context',
			},
			{
				module: 'ai-coding-crash-course',
				lesson: 'write-great-specs-with-this-skill-362ad013',
				href: 'https://www.aihero.dev/workshops/ai-coding-crash-course/write-great-specs-with-this-skill-362ad013',
				label: 'Write Great Specs With This Skill',
			},
		])
		expect(block.children[0].children).toMatchObject([
			{
				type: 'text',
				value: 'What a session is, and why the review runs in a fresh one.',
			},
		])
	})

	it('keeps inline code in a reason', () => {
		const block = transform(SAMPLE).children[1]
		expect(block.children[1].children).toMatchObject([
			{ type: 'text', value: 'What a spec made by ' },
			{ type: 'inlineCode', value: '/to-spec' },
			{
				type: 'text',
				value: ' contains, so you know what the code is reviewed against.',
			},
		])
	})

	it('handles CRLF bodies', () => {
		const tree = transform(SAMPLE.replace(/\n/g, '\r\n'))
		const block = tree.children[1]
		expect(block.name).toBe('Prerequisites')
		expect(block.children).toHaveLength(2)
		for (const item of block.children) {
			const text = JSON.stringify(item.children)
			expect(text).not.toContain('\\r')
		}
	})

	it('accepts relative lesson links', () => {
		const tree = transform(
			'## Prerequisites\n\n- [A](/workshops/mod/lesson-a): Reason.\n',
		)
		expect(tree.children[0].name).toBe('Prerequisites')
		expect(attrs(tree.children[0].children[0])).toMatchObject({
			module: 'mod',
			lesson: 'lesson-a',
		})
	})

	it('leaves prose under "## Prerequisites" alone', () => {
		const tree = transform(
			'## Prerequisites\n\nYou should know TypeScript.\n\n- Node 20\n- pnpm\n',
		)
		expect(topLevel(tree)).toEqual(['heading', 'paragraph', 'list'])
	})

	it('leaves a list with one non-lesson link alone', () => {
		const tree = transform(
			[
				'## Crash Course Prerequisites',
				'',
				'- [A](https://www.aihero.dev/workshops/mod/a): Reason A.',
				'- [Docs](https://example.com/docs): Reason B.',
			].join('\n'),
		)
		expect(topLevel(tree)).toEqual(['heading', 'list'])
	})

	it('leaves an item without a reason alone', () => {
		const tree = transform(
			'## Prerequisites\n\n- [A](https://www.aihero.dev/workshops/mod/a)\n',
		)
		expect(topLevel(tree)).toEqual(['heading', 'list'])
	})

	it('leaves the list alone when a reason contains a link', () => {
		for (const reason of [
			'See [the docs](https://example.com/docs) first.',
			'Read https://example.com/docs first.',
			'See [the docs][docs] first.\n\n[docs]: https://example.com/docs',
			'Some **[bold link](/workshops/m/x)** here.',
		]) {
			const tree = transform(
				`## Crash Course Prerequisites\n\n- [A](/workshops/mod/a): Fine.\n- [B](/workshops/mod/b): ${reason}\n`,
			)
			expect(tree.children[0].type, reason).toBe('heading')
			expect(tree.children[1].type, reason).toBe('list')
		}
	})

	it('leaves a heading not followed by a list alone', () => {
		const tree = transform(
			'## Crash Course Prerequisites\n\nSee below.\n\n- [A](/workshops/mod/a): Reason.\n',
		)
		expect(topLevel(tree)).toEqual(['heading', 'paragraph', 'list'])
	})

	it('leaves other headings alone', () => {
		const tree = transform('## Further Reading\n\n- [A](/workshops/mod/a): Reason.\n')
		expect(topLevel(tree)).toEqual(['heading', 'list'])
	})

	it('compiles to Prerequisites/Prerequisite elements through MDX', async () => {
		const { default: Content } = await evaluate(SAMPLE, {
			...(runtime as any),
			remarkPlugins: [remarkGfm, remarkPrerequisites],
		})
		const html = renderToStaticMarkup(
			<Content
				components={{
					Prerequisites: ({ title, children }: any) => (
						<section data-title={title}>{children}</section>
					),
					Prerequisite: ({ lesson, children }: any) => (
						<p data-lesson={lesson}>{children}</p>
					),
				}}
			/>,
		)
		expect(html).toContain(
			'<section data-title="Crash Course Prerequisites"><p data-lesson="sessions-and-the-context-241f60ee">What a session is, and why the review runs in a fresh one.</p>',
		)
		expect(html).toContain(
			'What a spec made by <code>/to-spec</code> contains, so you know what the code is reviewed against.',
		)
	})
})

describe('parseLessonUrl', () => {
	it.each([
		['https://www.aihero.dev/workshops/m/l', { module: 'm', lesson: 'l' }],
		['https://aihero.dev/workshops/m/l/', { module: 'm', lesson: 'l' }],
		['/workshops/m/l#video', { module: 'm', lesson: 'l' }],
		['/workshops/m', null],
		['/workshops/m/l/solution', null],
		['https://evil.dev/workshops/m/l', null],
		['/posts/m/l', null],
	])('%s', (url, expected) => {
		expect(parseLessonUrl(url)).toEqual(expected)
	})
})
