import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const githubMocks = vi.hoisted(() => ({
	getContent: vi.fn(),
}))

vi.mock('@octokit/rest', () => ({
	Octokit: class {
		rest = {
			repos: {
				getContent: githubMocks.getContent,
			},
		}
	},
}))

import { fetchGithubMarkdownFile } from './github-markdown'

const ref = {
	owner: 'mattpocock',
	repo: 'dictionary-of-ai-coding',
	path: 'README.md',
	ref: 'abc123',
}

describe('fetchGithubMarkdownFile', () => {
	beforeEach(() => {
		githubMocks.getContent.mockReset()
	})

	afterEach(() => {
		vi.unstubAllGlobals()
	})

	it('reads a public file from the raw host without touching the GitHub API', async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(new Response('# Dictionary', { status: 200 }))
		const signal = new AbortController().signal
		vi.stubGlobal('fetch', fetchMock)

		const markdown = await fetchGithubMarkdownFile({
			...ref,
			transport: 'raw-only',
			revalidate: 3600,
			tags: ['ai-coding-dictionary'],
			signal,
		})

		expect(markdown).toBe('# Dictionary')
		expect(githubMocks.getContent).not.toHaveBeenCalled()
		expect(fetchMock).toHaveBeenCalledWith(
			'https://raw.githubusercontent.com/mattpocock/dictionary-of-ai-coding/abc123/README.md',
			{
				next: {
					revalidate: 3600,
					tags: ['ai-coding-dictionary'],
				},
				signal,
			},
		)
	})

	it('uses the raw host for anonymous GitHub markdown sources', async () => {
		githubMocks.getContent.mockRejectedValue({ status: 403 })
		const fetchMock = vi
			.fn()
			.mockResolvedValue(new Response('# Fallback', { status: 200 }))
		vi.stubGlobal('fetch', fetchMock)

		await expect(fetchGithubMarkdownFile(ref)).resolves.toBe('# Fallback')
		expect(githubMocks.getContent).not.toHaveBeenCalled()
		expect(fetchMock).toHaveBeenCalledOnce()
	})
})
