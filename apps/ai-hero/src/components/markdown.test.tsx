import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { Markdown } from './markdown'

describe('Markdown', () => {
	it('renders aihero.dev links as root-relative', () => {
		const html = renderToStaticMarkup(
			<Markdown>{'[skills](https://www.aihero.dev/skills)'}</Markdown>,
		)
		expect(html).toContain('href="/skills"')
		expect(html).not.toContain('aihero.dev')
	})

	it('leaves external links alone', () => {
		const html = renderToStaticMarkup(
			<Markdown>{'[docs](https://example.com/docs)'}</Markdown>,
		)
		expect(html).toContain('href="https://example.com/docs"')
	})

	// The ordering guarantee the wrapper exists for: a caller plugin (e.g.
	// rehype-raw in the landing hero) runs FIRST, and anchors it produces are
	// still rewritten.
	it('rewrites anchors produced by a caller-supplied rehype plugin', () => {
		const injectAnchor = () => (tree: any) => {
			tree.children.push({
				type: 'element',
				tagName: 'a',
				properties: { href: 'https://www.aihero.dev/injected' },
				children: [{ type: 'text', value: 'injected' }],
			})
		}

		const html = renderToStaticMarkup(
			<Markdown rehypePlugins={[injectAnchor]}>{'body'}</Markdown>,
		)
		expect(html).toContain('href="/injected"')
		expect(html).not.toContain('aihero.dev')
	})

	it('keeps caller-supplied props working', () => {
		const html = renderToStaticMarkup(
			<Markdown components={{ p: ({ children }) => <>{children}</> }}>
				{'[grill me](https://aihero.dev/skills-grill-me)'}
			</Markdown>,
		)
		expect(html).toBe('<a href="/skills-grill-me">grill me</a>')
	})
})
