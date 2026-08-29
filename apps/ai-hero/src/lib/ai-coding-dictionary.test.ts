import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const githubMocks = vi.hoisted(() => ({
	getBranch: vi.fn(),
	getContent: vi.fn(),
	getTree: vi.fn(),
}))

vi.mock('next/cache', () => ({
	unstable_cache: (operation: (...args: never[]) => unknown) => operation,
}))

vi.mock('@octokit/rest', () => ({
	Octokit: class {
		rest = {
			git: {
				getTree: githubMocks.getTree,
			},
			repos: {
				getBranch: githubMocks.getBranch,
				getContent: githubMocks.getContent,
			},
		}
	},
}))

import { getAiCodingDictionary } from './ai-coding-dictionary'

const COMMIT_SHA = '251fec7ec3b08059e4203863024e6123090a54e3'
const UPDATED_AT = '2026-07-01T08:46:18.000Z'

const commitFeed = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <updated>2026-07-01T08:46:18Z</updated>
  <entry>
    <id>tag:github.com,2008:Grit::Commit/${COMMIT_SHA}</id>
    <updated>2026-07-01T08:46:18Z</updated>
  </entry>
</feed>`

const readme = `# AI Coding Dictionary

Introductory content stays outside the parsed sections.

## Section 1 — Foundations

### AI

README body for AI with a link to [Model](#model).

### Model

README fallback description for Model.
`

const aiFrontmatter = `---
description: "Frontmatter description for AI"
aliases:
  - Artificial intelligence
  - AI system
---

Source body is not used for the rendered dictionary entry.
`

function urlOf(input: unknown) {
	return typeof input === 'string' ? input : String(input)
}

describe('AI Coding Dictionary GitHub source', () => {
	beforeEach(() => {
		githubMocks.getBranch.mockReset().mockRejectedValue({ status: 403 })
		githubMocks.getContent.mockReset().mockRejectedValue({ status: 403 })
		githubMocks.getTree.mockReset().mockRejectedValue({ status: 403 })
	})

	afterEach(() => {
		vi.unstubAllGlobals()
	})

	it('loads one coherent raw snapshot with frontmatter and a truthful update date', async () => {
		const fetchMock = vi.fn(async (input: unknown, _init?: unknown) => {
			const url = urlOf(input)

			if (url.endsWith('/commits/main.atom')) {
				return new Response(commitFeed, { status: 200 })
			}
			if (url.endsWith(`/${COMMIT_SHA}/README.md`)) {
				return new Response(readme, { status: 200 })
			}
			if (url.endsWith(`/${COMMIT_SHA}/dictionary/AI.md`)) {
				return new Response(aiFrontmatter, { status: 200 })
			}
			if (url.endsWith(`/${COMMIT_SHA}/dictionary/Model.md`)) {
				return new Response('upstream unavailable', { status: 503 })
			}

			throw new Error(`Unexpected fetch: ${url}`)
		})
		vi.stubGlobal('fetch', fetchMock)

		const dictionary = await getAiCodingDictionary()

		expect(githubMocks.getContent).not.toHaveBeenCalled()
		expect(githubMocks.getTree).not.toHaveBeenCalled()
		expect(githubMocks.getBranch).not.toHaveBeenCalled()
		expect(dictionary.updatedAt).toBe(UPDATED_AT)
		expect(dictionary.entries).toHaveLength(2)
		expect(dictionary.entries[0]).toMatchObject({
			title: 'AI',
			path: 'dictionary/AI.md',
			githubUrl:
				'https://github.com/mattpocock/dictionary-of-ai-coding/blob/main/dictionary/AI.md',
			description: 'Frontmatter description for AI',
			aliases: ['Artificial intelligence', 'AI system'],
			rawBody: 'README body for AI with a link to [Model](#model).',
			body: 'README body for AI with a link to [Model](/ai-coding-dictionary/model).',
		})
		expect(dictionary.entries[1]).toMatchObject({
			title: 'Model',
			description: 'README fallback description for Model.',
			aliases: [],
		})
		expect(
			fetchMock.mock.calls.every(
				([input]) => !urlOf(input).includes('api.github.com'),
			),
		).toBe(true)
		expect(fetchMock.mock.calls).toHaveLength(4)

		for (const [, init] of fetchMock.mock.calls) {
			expect(init).toMatchObject({
				next: {
					revalidate: 3600,
					tags: ['ai-coding-dictionary'],
				},
			})
		}
	})

	it('fails instead of publishing a made-up source date', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				new Response('<feed><updated>not-a-date</updated></feed>', {
					status: 200,
				}),
			),
		)

		await expect(getAiCodingDictionary()).rejects.toThrow(
			'GitHub commit feed did not contain a valid commit and update date',
		)
	})
})
