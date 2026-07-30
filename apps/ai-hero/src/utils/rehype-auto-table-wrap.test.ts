import { evaluate } from '@mdx-js/mdx'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import * as runtime from 'react/jsx-runtime'
import remarkGfm from 'remark-gfm'
import { describe, expect, it } from 'vitest'

import { rehypeAutoTableWrap } from './rehype-auto-table-wrap'

// Marker stand-in for the real TableWrapper so wrap count and nesting are
// assertable on static markup.
const components = {
	TableWrapper: ({ children }: { children: React.ReactNode }) =>
		React.createElement('div', { 'data-table-wrap': '' }, children),
}

async function render(source: string) {
	const { default: MDXContent } = await evaluate(source, {
		...runtime,
		remarkPlugins: [remarkGfm],
		rehypePlugins: [rehypeAutoTableWrap],
	})
	return renderToStaticMarkup(
		React.createElement(MDXContent, { components } as never),
	)
}

function wrapCount(html: string) {
	return (html.match(/data-table-wrap/g) ?? []).length
}

function hasNestedWrap(html: string) {
	return /data-table-wrap[^>]*>(?:(?!<\/div>)[^])*?<div data-table-wrap/.test(
		html,
	)
}

const markdownTable = '| a | b |\n| - | - |\n| 1 | 2 |'

describe('rehypeAutoTableWrap', () => {
	it('wraps a bare markdown table exactly once', async () => {
		const html = await render(markdownTable)
		expect(wrapCount(html)).toBe(1)
		expect(html).toContain('<table>')
	})

	it('leaves a hand-wrapped markdown table with a single wrapper', async () => {
		const html = await render(
			`<TableWrapper>\n\n${markdownTable}\n\n</TableWrapper>`,
		)
		expect(wrapCount(html)).toBe(1)
		expect(hasNestedWrap(html)).toBe(false)
	})

	it('wraps a literal JSX table exactly once', async () => {
		const html = await render(
			'<table><tbody><tr><td>x</td></tr></tbody></table>',
		)
		expect(wrapCount(html)).toBe(1)
	})

	it('leaves a hand-wrapped literal JSX table with a single wrapper', async () => {
		const html = await render(
			'<TableWrapper><table><tbody><tr><td>x</td></tr></tbody></table></TableWrapper>',
		)
		expect(wrapCount(html)).toBe(1)
		expect(hasNestedWrap(html)).toBe(false)
	})

	it('wraps a markdown table nested inside another component', async () => {
		const html = await render(
			`<section>\n\n${markdownTable}\n\n</section>`,
		)
		expect(wrapCount(html)).toBe(1)
	})

	it('wraps each of multiple tables independently', async () => {
		const html = await render(
			`${markdownTable}\n\nsome prose\n\n${markdownTable}`,
		)
		expect(wrapCount(html)).toBe(2)
		expect(hasNestedWrap(html)).toBe(false)
	})

	it('does not touch content without tables', async () => {
		const html = await render('# Heading\n\njust prose')
		expect(wrapCount(html)).toBe(0)
	})
})
