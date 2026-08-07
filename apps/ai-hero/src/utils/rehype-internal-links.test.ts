import { evaluate } from '@mdx-js/mdx'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import * as runtime from 'react/jsx-runtime'
import rehypeExternalLinks from 'rehype-external-links'
import remarkGfm from 'remark-gfm'
import { describe, expect, it } from 'vitest'

import { rehypeInternalLinks, toInternalHref } from './rehype-internal-links'

// Mirrors the real pipeline's ordering: internal-link rewriting must run
// first, or `rehype-external-links` stamps our own links `target="_blank"`.
async function render(source: string) {
	const { default: MDXContent } = await evaluate(source, {
		...runtime,
		remarkPlugins: [remarkGfm],
		rehypePlugins: [
			rehypeInternalLinks,
			[rehypeExternalLinks, { target: '_blank', rel: ['noopener'] }],
		],
	})
	return renderToStaticMarkup(React.createElement(MDXContent, {} as never))
}

describe('toInternalHref', () => {
	it('strips the origin from links to this site', () => {
		expect(toInternalHref('https://aihero.dev/skills-grill-me')).toBe(
			'/skills-grill-me',
		)
		expect(toInternalHref('https://www.aihero.dev/skills')).toBe('/skills')
		expect(toInternalHref('http://aihero.dev/skills')).toBe('/skills')
		expect(toInternalHref('https://AIHero.dev/skills')).toBe('/skills')
	})

	it('keeps the query string and hash', () => {
		expect(toInternalHref('https://aihero.dev/skills?a=1#install')).toBe(
			'/skills?a=1#install',
		)
	})

	it('maps a bare origin to the root path', () => {
		expect(toInternalHref('https://aihero.dev')).toBe('/')
	})

	it('leaves a non-default port alone', () => {
		// A root-relative path cannot carry a port, so rewriting would send the
		// reader to this site's default port instead of the service they meant.
		expect(toInternalHref('https://aihero.dev:8443/docs')).toBeNull()
		// ...but the protocol's own default port is still just us.
		expect(toInternalHref('https://aihero.dev:443/docs')).toBe('/docs')
		expect(toInternalHref('http://aihero.dev:80/docs')).toBe('/docs')
	})

	it('leaves everything else alone', () => {
		expect(toInternalHref('https://example.com/skills')).toBeNull()
		// A lookalike host is not us.
		expect(toInternalHref('https://notaihero.dev/skills')).toBeNull()
		expect(toInternalHref('/skills')).toBeNull()
		expect(toInternalHref('#install')).toBeNull()
		expect(toInternalHref('mailto:matt@aihero.dev')).toBeNull()
	})
})

describe('rehypeInternalLinks', () => {
	it('rewrites a markdown link and leaves it internal', async () => {
		const html = await render('[grill me](https://aihero.dev/skills-grill-me)')
		expect(html).toContain('href="/skills-grill-me"')
		expect(html).not.toContain('aihero.dev')
		expect(html).not.toContain('target="_blank"')
	})

	it('still marks genuinely external links as external', async () => {
		const html = await render('[docs](https://example.com/docs)')
		expect(html).toContain('href="https://example.com/docs"')
		expect(html).toContain('target="_blank"')
	})

	it('rewrites hand-authored anchor JSX', async () => {
		const html = await render('<a href="https://aihero.dev/skills">skills</a>')
		expect(html).toContain('href="/skills"')
	})
})
