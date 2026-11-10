import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/github-markdown', () => ({
	fetchGithubMarkdownFile: vi.fn(),
}))

import { parseSandcastleGuide } from './sandcastle-docs'

describe('parseSandcastleGuide', () => {
	const docs = parseSandcastleGuide({
		toc: {
			start: 'getting-started',
			groups: [
				{
					title: 'Guides',
					pages: ['getting-started', 'prompts', 'sandbox-providers'],
				},
			],
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

Timeouts follow the [timeout ADR][adr].

[adr]: ../adr/0019-timeout.md
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

	it('orders pages and groups as toc.json lists them, the start page once', () => {
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
		expect(page('prompts').body).toContain(
			`[adr]: ${blob}/docs/adr/0019-timeout.md`,
		)
		expect(page('prompts').sourceUrl).toBe(`${blob}/docs/guide/prompts.md`)
	})

	it('escapes JSX-looking text for MDX only', () => {
		expect(page('prompts').body).toContain('Record\\<string, string>')
		expect(page('prompts').markdown).toContain('Record<string, string>')
	})
})
