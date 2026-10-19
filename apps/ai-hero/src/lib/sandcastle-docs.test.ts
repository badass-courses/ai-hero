import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/github-markdown', () => ({
	fetchGithubMarkdownFile: vi.fn(),
}))

import { parseSandcastleReadme } from './sandcastle-docs'

const README = `<div align="center">
  <img alt="Sandcastle" src="logo.png">
</div>

## What Is Sandcastle?

A library for agents:

1. You invoke agents with a single \`sandcastle.run()\`.
2. Sandcastle handles sandboxing.

Or [create your own](#custom-sandbox-providers).

## Quick start

\`\`\`bash
npm install
\`\`\`

\`\`\`typescript
await run({ agent })
\`\`\`

## Sandbox Providers

| Provider | Import path | Type |
| --- | --- | --- |
| Docker | \`@ai-hero/sandcastle/sandboxes/docker\` | Bind-mount |

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

Back to [dynamic context](#dynamic-context-with-command).

## Changelog

Something the groups do not know about yet.
`

describe('parseSandcastleReadme', () => {
	const docs = parseSandcastleReadme(README)
	const page = (slug: string) => docs.pages.find((p) => p.slug === slug)!

	it('files each section under its sidebar group, unknown ones under More', () => {
		expect(
			docs.groups.map((group) => [group.title, group.pages.map((p) => p.href)]),
		).toEqual([
			[
				'Getting started',
				['/sandcastle/what-is-sandcastle', '/sandcastle/quick-start'],
			],
			['Guides', ['/sandcastle/sandbox-providers', '/sandcastle/prompts']],
			['Reference', ['/sandcastle/custom-sandbox-providers']],
			['More', ['/sandcastle/changelog']],
		])
		expect(docs.pages.map((p) => p.slug)).toEqual(
			docs.groups.flatMap((group) => group.pages.map((p) => p.slug)),
		)
	})

	it('pulls the landing facts out of the README', () => {
		expect(docs.lead).toBe('A library for agents.')
		expect(docs.steps).toEqual([
			'You invoke agents with a single `sandcastle.run()`.',
			'Sandcastle handles sandboxing.',
		])
		expect(docs.providers).toEqual([
			{
				name: 'Docker',
				importPath: '@ai-hero/sandcastle/sandboxes/docker',
				type: 'Bind-mount',
			},
		])
		expect(docs.example).toBe('await run({ agent })')
	})

	it('promotes headings one level and leaves code fences alone', () => {
		const body = page('prompts').body
		expect(body).toContain('## Dynamic context with `` !`command` ``')
		expect(body).toContain('### Hanging processes')
		expect(body).toContain('# Open issues')
	})

	it('points README anchors at the page that holds the heading', () => {
		expect(page('what-is-sandcastle').body).toContain(
			'[create your own](/sandcastle/custom-sandbox-providers)',
		)
		expect(page('custom-sandbox-providers').body).toContain(
			'[dynamic context](/sandcastle/prompts#dynamic-context-with-command)',
		)
		expect(page('prompts').body).toContain('[Prompts](/sandcastle/prompts)')
	})

	it('sends repo-relative links to GitHub and keeps absolute ones', () => {
		expect(page('prompts').body).toContain(
			'[ADR 0019](https://github.com/mattpocock/sandcastle/blob/main/docs/adr/0019-completion-timeout.md)',
		)
		expect(page('prompts').body).toContain('[the site](https://www.aihero.dev)')
	})

	it('escapes JSX-looking text but leaves code alone', () => {
		expect(page('custom-sandbox-providers').body).toContain(
			'| `env` | Record\\<string, string> |',
		)
		expect(
			parseSandcastleReadme('## A\n\n`<a>{b}` and {c}\n').pages[0]!.body,
		).toBe('`<a>{b}` and \\{c\\}')
	})
})
