import { evaluate } from '@mdx-js/mdx'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import * as runtime from 'react/jsx-runtime'
import remarkGfm from 'remark-gfm'
import { describe, expect, it } from 'vitest'

import { createDictionaryAutoLinkRemarkPlugin } from '@/lib/dictionary-autolink'
import type { DictionaryEntry } from '@/lib/ai-coding-dictionary'

const entries = [
	{
		slug: 'agent',
		title: 'Agent',
		description: 'A model in a loop.',
		aliases: ['agent', 'agents'],
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

describe('repro: real lesson paragraph', () => {
	it('keeps the hand-authored link', async () => {
		const src =
			'The first most important thing to understand in order to work with AI [agents](https://www.aihero.dev/ai-coding-dictionary/agent) is what an agent even is, and how they relate.'
		const html = await render(src, 3)
		console.log('OUT:', html)
		expect(html).toContain('ai-coding-dictionary/agent')
	})
})
