import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/github-markdown', () => ({
	fetchGithubMarkdownFile: vi.fn(),
}))

import { parseSandcastleGuide, parseSandcastleReadme } from './sandcastle-docs'

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

See [ADR 0019](docs/adr/0019-completion-timeout.md), [Prompts](#prompts), [Quick start](#quick-start) and [the site](https://www.aihero.dev). It is [licensed](#license).

## Custom Sandbox Providers

| Option | Type |
| --- | --- |
| \`env\` | Record<string, string> |

Back to [dynamic context](#dynamic-context-with-command).

## Changelog

### Options

### Options

Something the groups do not know about yet. See [the second](#options-1).

## License

MIT
`

describe('parseSandcastleReadme', () => {
	const docs = parseSandcastleReadme(README)
	const page = (slug: string) => docs.pages.find((p) => p.slug === slug)!

	it('files each section under its sidebar group, unknown ones under More', () => {
		expect(
			docs.groups.map((group) => [group.title, group.pages.map((p) => p.href)]),
		).toEqual([
			['Guides', ['/sandcastle/sandbox-providers', '/sandcastle/prompts']],
			['Reference', ['/sandcastle/custom-sandbox-providers']],
			['More', ['/sandcastle/changelog']],
		])
		expect(docs.pages.map((p) => p.slug)).toEqual([
			'getting-started',
			...docs.groups.flatMap((group) => group.pages.map((p) => p.slug)),
		])
	})

	it('joins the opening sections into one start page that keeps their headings', () => {
		expect(docs.start).toMatchObject({
			title: 'Getting started',
			href: '/sandcastle/getting-started',
			description: 'A library for agents.',
		})
		expect(docs.start!.body).toMatch(
			/^## What Is Sandcastle\?\n[\s\S]*\n## Quick start\n/,
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
		expect(docs.license).toBe('MIT')
		expect(docs.pages.map((p) => p.slug)).not.toContain('license')
		expect(page('prompts').body).toContain(
			'[licensed](https://github.com/mattpocock/sandcastle/blob/main/README.md#license)',
		)
	})

	it('promotes headings one level and leaves code fences alone', () => {
		const body = page('prompts').body
		expect(body).toContain('## Dynamic context with `` !`command` ``')
		expect(body).toContain('### Hanging processes')
		expect(body).toContain('# Open issues')
	})

	it('points README anchors at the page that holds the heading', () => {
		expect(page('getting-started').body).toContain(
			'[create your own](/sandcastle/custom-sandbox-providers)',
		)
		expect(page('custom-sandbox-providers').body).toContain(
			'[dynamic context](/sandcastle/prompts#dynamic-context-with-command)',
		)
		expect(page('prompts').body).toContain('[Prompts](/sandcastle/prompts)')
		expect(page('prompts').body).toContain(
			'[Quick start](/sandcastle/getting-started#quick-start)',
		)
	})

	it('resolves the numbered anchor GitHub gives a repeated heading', () => {
		expect(page('changelog').body).toContain(
			'[the second](/sandcastle/changelog#options)',
		)
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

describe('parseSandcastleGuide', () => {
	const docs = parseSandcastleGuide({
		toc: {
			start: 'getting-started',
			groups: [{ title: 'Guides', pages: ['prompts', 'sandbox-providers'] }],
		},
		files: {
			'getting-started': `# Getting started

## What is Sandcastle?

A library for agents:

1. You invoke agents with a single \`sandcastle.run()\`.
2. The commits get merged back.

See [dynamic context](./prompts.md#dynamic-context) and [a draft](./draft.md).

## Quick start

\`\`\`bash
npm install
\`\`\`

\`\`\`ts
await run({ agent })
\`\`\`
`,
			prompts: `# Prompts

Prompts are files. They take arguments.

## Dynamic context

Pass a Record<string, string>. See [ADR 0019](../adr/0019-timeout.md), [quick start](./getting-started.md#quick-start), [this section](#dynamic-context) and [the license](../../README.md#license).
`,
			'sandbox-providers': `# Sandbox providers

| Provider | Import path | Type |
| --- | --- | --- |
| Docker | \`@ai-hero/sandcastle/sandboxes/docker\` | Bind-mount |
`,
		},
		readme: '# Sandcastle\n\n## Development\n\nnpm test\n\n## License\n\nMIT\n',
	})
	const page = (slug: string) => docs.pages.find((p) => p.slug === slug)!

	it('orders pages and groups as toc.json lists them', () => {
		expect(docs.pages.map((p) => p.href)).toEqual([
			'/sandcastle/getting-started',
			'/sandcastle/prompts',
			'/sandcastle/sandbox-providers',
		])
		expect(docs.start).toMatchObject({
			title: 'Getting started',
			group: 'Start here',
		})
		expect(
			docs.groups.map((group) => [group.title, group.pages.map((p) => p.slug)]),
		).toEqual([['Guides', ['prompts', 'sandbox-providers']]])
	})

	it('takes each title from its # heading and keeps the rest as the body', () => {
		expect(page('prompts').title).toBe('Prompts')
		expect(page('prompts').body).toMatch(/^Prompts are files\./)
		expect(page('prompts').description).toBe('Prompts are files.')
		expect(page('getting-started').body).toMatch(/^## What is Sandcastle\?/)
	})

	it('pulls the landing facts out of the pages', () => {
		expect(docs.lead).toBe('A library for agents.')
		expect(docs.steps).toEqual([
			'You invoke agents with a single `sandcastle.run()`.',
			'The commits get merged back.',
		])
		expect(docs.example).toBe('await run({ agent })')
		expect(docs.providers).toEqual([
			{
				name: 'Docker',
				importPath: '@ai-hero/sandcastle/sandboxes/docker',
				type: 'Bind-mount',
			},
		])
		expect(docs.license).toBe('MIT')
	})

	it('turns links between pages into site links', () => {
		const body = page('prompts').body
		expect(body).toContain(
			'[quick start](/sandcastle/getting-started#quick-start)',
		)
		expect(body).toContain(
			'[this section](/sandcastle/prompts#dynamic-context)',
		)
		expect(page('getting-started').body).toContain(
			'[dynamic context](/sandcastle/prompts#dynamic-context)',
		)
	})

	it('opens other repo files, and unlisted pages, on GitHub', () => {
		const blob = 'https://github.com/mattpocock/sandcastle/blob/main'
		expect(page('prompts').body).toContain(
			`[ADR 0019](${blob}/docs/adr/0019-timeout.md)`,
		)
		expect(page('prompts').body).toContain(
			`[the license](${blob}/README.md#license)`,
		)
		expect(page('getting-started').body).toContain(
			`[a draft](${blob}/docs/guide/draft.md)`,
		)
		expect(page('prompts').sourceUrl).toBe(`${blob}/docs/guide/prompts.md`)
	})

	it('escapes JSX-looking text for MDX only', () => {
		expect(page('prompts').body).toContain('Record\\<string, string>')
		expect(page('prompts').markdown).toContain('Record<string, string>')
	})
})
