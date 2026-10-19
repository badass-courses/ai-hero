import { evaluate } from '@mdx-js/mdx'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import * as runtime from 'react/jsx-runtime'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/github-markdown', () => ({
	fetchGithubMarkdownFile: vi.fn(),
}))

import { createDictionaryAutoLinkRemarkPlugin } from '@/lib/dictionary-autolink'

import {
	remarkSandcastleLinks,
	SANDCASTLE_PAGE_AUTOLINK,
} from './remark-sandcastle-links'

async function render(source: string) {
	const { default: MDXContent } = await evaluate(source, {
		...runtime,
		remarkPlugins: [
			remarkSandcastleLinks,
			createDictionaryAutoLinkRemarkPlugin({
				entries: [],
				pages: [SANDCASTLE_PAGE_AUTOLINK],
			}),
		],
	})
	return renderToStaticMarkup(React.createElement(MDXContent, {} as never))
}

// The lesson bodies these cases come from link the repo by the tool's name.
describe('Sandcastle links in lesson bodies', () => {
	it('opens a link named Sandcastle on the docs, and links no later mention again', async () => {
		expect(
			await render(
				'So I built [Sandcastle](https://github.com/mattpocock/sandcastle). Sandcastle runs agents.',
			),
		).toBe(
			'<p>So I built <a href="/sandcastle">Sandcastle</a>. Sandcastle runs agents.</p>',
		)
	})

	it('keeps links that mean GitHub on GitHub', async () => {
		const html = await render(
			'Check out the [Sandcastle repository](https://github.com/mattpocock/sandcastle) and [this issue](https://github.com/mattpocock/sandcastle/issues/191).',
		)
		expect(html).toContain('href="https://github.com/mattpocock/sandcastle"')
		expect(html).toContain(
			'href="https://github.com/mattpocock/sandcastle/issues/191"',
		)
		// An author's GitHub link is not a link to the docs, so the docs still
		// have none: there is no plain "Sandcastle" left to give one, either.
		expect(html.match(/href="\/sandcastle"/g)).toBeNull()
	})

	it('links the first plain mention of the name, never paths or channels', async () => {
		expect(
			await render(
				'Open .sandcastle/main.ts and ask in #sandcastle. Sandcastle handles the sandbox. Sandcastle merges back.',
			),
		).toBe(
			'<p>Open .sandcastle/main.ts and ask in #sandcastle. <a href="/sandcastle">Sandcastle</a> handles the sandbox. Sandcastle merges back.</p>',
		)
	})
})
