import { evaluate } from '@mdx-js/mdx'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import * as runtime from 'react/jsx-runtime'
import remarkGfm from 'remark-gfm'
import { describe, expect, it } from 'vitest'

import { createDictionaryAutoLinkRemarkPlugin } from '../dictionary-autolink'
import type { DictionaryEntry } from '../ai-coding-dictionary'

const entries = [
	{
		slug: 'agent',
		title: 'Agent',
		description: 'A model in a loop with tools.',
		aliases: ['agent'],
	},
] as DictionaryEntry[]

async function render(source: string, maxLinks: number) {
	const { default: MDXContent } = await evaluate(source, {
		...runtime,
		remarkPlugins: [
			remarkGfm,
			createDictionaryAutoLinkRemarkPlugin({ entries, maxLinks }),
		],
	})
	return renderToStaticMarkup(React.createElement(MDXContent, {} as never))
}

describe('createDictionaryAutoLinkRemarkPlugin', () => {
	it('auto-links dictionary terms when a budget is given', async () => {
		const html = await render('An agent does the work.', 3)
		expect(html).toContain('/ai-coding-dictionary/agent')
	})

	it('inserts no links at all when maxLinks is 0', async () => {
		const html = await render('An agent does the work.', 0)
		expect(html).not.toContain('<a')
	})

	// Both article and lesson bodies mix hand-authored links with auto-linked
	// ones, so the author's own link must survive untouched and unnested.
	it('leaves a hand-authored link alone and does not nest inside it', async () => {
		const html = await render(
			'The [agent](https://www.aihero.dev/ai-coding-dictionary/agent) works.',
			3,
		)
		expect(html).toBe(
			'<p>The <a href="https://www.aihero.dev/ai-coding-dictionary/agent">agent</a> works.</p>',
		)
	})

	it('auto-links a term the author forgot, once per lesson', async () => {
		const html = await render(
			'An agent plans. The agent then executes.',
			3,
		)
		expect(html.match(/<a /g)).toHaveLength(1)
	})
})
