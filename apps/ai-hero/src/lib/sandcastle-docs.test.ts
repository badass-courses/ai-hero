import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/github-markdown', () => ({
	fetchGithubMarkdownFile: vi.fn(),
}))

import { parseSandcastleReadme } from './sandcastle-docs'

const README = `<div align="center">
  <img alt="Sandcastle" src="logo.png">
</div>

## What Is Sandcastle?

A library. Or [create your own](#custom-sandbox-providers).

## Prompts

### Dynamic context with \`\` !\`command\` \`\`

\`\`\`md
# Open issues

!\`gh issue list\`
\`\`\`

#### Hanging processes

See [ADR 0019](docs/adr/0019-completion-timeout.md), [Prompts](#prompts) and [the site](https://www.aihero.dev).

## Custom Sandbox Providers

| Option | Type |
| --- | --- |
| \`env\` | Record<string, string> |

Implement the handle. Back to [dynamic context](#dynamic-context-with-command).
`

describe('parseSandcastleReadme', () => {
	const pages = parseSandcastleReadme(README)

	it('makes one page per top-level section, the first one the index', () => {
		expect(pages.map((page) => [page.title, page.href])).toEqual([
			['What Is Sandcastle?', '/sandcastle'],
			['Prompts', '/sandcastle/prompts'],
			['Custom Sandbox Providers', '/sandcastle/custom-sandbox-providers'],
		])
	})

	it('drops the logo block before the first section', () => {
		expect(pages[0]!.body).toBe(
			'A library. Or [create your own](/sandcastle/custom-sandbox-providers).',
		)
	})

	it('promotes headings one level and leaves code fences alone', () => {
		const body = pages[1]!.body
		expect(body).toContain('## Dynamic context with `` !`command` ``')
		expect(body).toContain('### Hanging processes')
		expect(body).toContain('# Open issues')
		expect(pages[1]!.headings).toEqual([
			{ title: 'Dynamic context with !`command`', anchor: expect.any(String) },
		])
	})

	it('points README anchors at the page that holds the heading', () => {
		const anchor = pages[1]!.headings[0]!.anchor
		expect(pages[2]!.body).toContain(
			`[dynamic context](/sandcastle/prompts#${anchor})`,
		)
		expect(pages[1]!.body).toContain('[Prompts](/sandcastle/prompts)')
	})

	it('sends repo-relative links to GitHub and keeps absolute ones', () => {
		expect(pages[1]!.body).toContain(
			'[ADR 0019](https://github.com/mattpocock/sandcastle/blob/main/docs/adr/0019-completion-timeout.md)',
		)
		expect(pages[1]!.body).toContain('[the site](https://www.aihero.dev)')
	})
})

describe('parseSandcastleReadme MDX safety', () => {
	it('escapes JSX-looking text but leaves code alone', () => {
		const [, , providers] = parseSandcastleReadme(README)
		expect(providers!.body).toContain('| `env` | Record\\<string, string> |')
		expect(parseSandcastleReadme('## A\n\n`<a>{b}` and {c}\n')[0]!.body).toBe(
			'`<a>{b}` and \\{c\\}',
		)
	})
})
