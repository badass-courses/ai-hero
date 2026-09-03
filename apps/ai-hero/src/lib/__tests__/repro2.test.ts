import { evaluate } from '@mdx-js/mdx'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import * as runtime from 'react/jsx-runtime'
import remarkGfm from 'remark-gfm'
import { describe, it } from 'vitest'
import { createDictionaryAutoLinkRemarkPlugin } from '@/lib/dictionary-autolink'

const entries = [
  { slug: 'agent', title: 'Agent', description: 'd', aliases: ['agent', 'agents'] },
  { slug: 'environment', title: 'Environment', description: 'd', aliases: ['environment'] },
  { slug: 'model', title: 'Model', description: 'd', aliases: ['model'] },
] as any

const src = `The first most important thing you'll need to understand in order to work with AI agents is what an agent even is, what its component parts are, and how they relate to each other.

There are four key elements to understand:

- **The [environment](https://www.aihero.dev/ai-coding-dictionary/environment)** - The outside world your agent interacts with
- **The agent** - The model harnessed in an environment
`

describe('repro2', () => {
  it('shows which occurrence wins', async () => {
    const { default: C } = await evaluate(src, {
      ...runtime,
      remarkPlugins: [remarkGfm, createDictionaryAutoLinkRemarkPlugin({ entries, maxLinks: 3 })],
    })
    console.log('OUT:', renderToStaticMarkup(React.createElement(C, {} as never)))
  })
})
