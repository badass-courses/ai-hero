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

	// Lesson bodies opt out of auto-linking: they already carry hand-authored
	// dictionary links, and pass entries only so those links get hover cards.
	it('inserts no links at all when maxLinks is 0', async () => {
		const html = await render('An agent does the work.', 0)
		expect(html).not.toContain('<a')
	})
})
