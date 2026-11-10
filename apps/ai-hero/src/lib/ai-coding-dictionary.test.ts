import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const githubMocks = vi.hoisted(() => ({
	getBranch: vi.fn(),
	getCommit: vi.fn(),
	getContent: vi.fn(),
	getTree: vi.fn(),
}))

vi.mock('next/cache', () => ({
	unstable_cache: (operation: (...args: never[]) => unknown) => operation,
}))

vi.mock('@octokit/rest', () => ({
	Octokit: class {
		rest = {
			git: { getTree: githubMocks.getTree },
			repos: {
				getBranch: githubMocks.getBranch,
				getCommit: githubMocks.getCommit,
				getContent: githubMocks.getContent,
			},
		}
	},
}))

let getAiCodingDictionary: typeof import('./ai-coding-dictionary').getAiCodingDictionary

const COMMIT_SHA = '251fec7ec3b08059e4203863024e6123090a54e3'
const UPDATED_AT = '2026-07-01T08:46:18.000Z'
const MEMO_MS = 5 * 60 * 1000
const commitData = {
	sha: COMMIT_SHA,
	commit: { committer: { date: UPDATED_AT } },
}
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

function signalOf(init: unknown) {
	return typeof init === 'object' && init && 'signal' in init
		? (init as { signal?: AbortSignal }).signal
		: undefined
}

function mockRawFetch() {
	const fetchMock = vi.fn(async (input: unknown, _init?: unknown) => {
		const url = urlOf(input)
		if (url.endsWith('/commits/main.atom')) return new Response(commitFeed)
		if (url.endsWith('/README.md')) return new Response(readme)
		if (url.endsWith('/dictionary/AI.md')) return new Response(aiFrontmatter)
		return new Response('unavailable', { status: 503 })
	})
	vi.stubGlobal('fetch', fetchMock)
	return fetchMock
}

function feedCalls(fetchMock: ReturnType<typeof mockRawFetch>) {
	return fetchMock.mock.calls.filter(([input]) =>
		urlOf(input).endsWith('/commits/main.atom'),
	)
}

describe('AI Coding Dictionary GitHub source', () => {
	beforeEach(async () => {
		// Each test starts cold; repeated loads bypass the mocked Next data cache.
		vi.resetModules()
		const dictionaryModule = await import('./ai-coding-dictionary')
		getAiCodingDictionary = dictionaryModule.getAiCodingDictionary
		githubMocks.getBranch.mockReset().mockRejectedValue({ status: 403 })
		githubMocks.getCommit.mockReset().mockResolvedValue({ data: commitData })
		githubMocks.getContent.mockReset().mockRejectedValue({ status: 403 })
		githubMocks.getTree.mockReset().mockRejectedValue({ status: 403 })
	})

	afterEach(() => {
		vi.useRealTimers()
		vi.unstubAllGlobals()
		vi.restoreAllMocks()
	})

	it('stores full SEO text separately without changing main UI/RSS descriptions', async () => {
		const full = 'Engineering vocabulary '.repeat(20).trim()
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: unknown) => {
				const url = urlOf(input)
				if (url.endsWith('/README.md'))
					return new Response(
						readme.replace(
							'README fallback description for Model.',
							`${full} \`*literal*\``,
						),
					)
				if (url.endsWith('/dictionary/AI.md'))
					return new Response(
						aiFrontmatter.replace(
							'Frontmatter description for AI',
							`*${full}*`,
						),
					)
				return new Response('not available', { status: 503 })
			}),
		)
		const dictionary = await getAiCodingDictionary()
		expect(dictionary.entries[0]?.description).toBe(`*${full}*`)
		expect(dictionary.entries[0]?.plainDescription).toBe(full)
		expect(dictionary.entries[1]?.description).toBe(
			`${full.slice(0, 177).trim()}...`,
		)
		expect(dictionary.entries[1]?.plainDescription).toBe(`${full} *literal*`)
		expect(
			dictionary.entries.every(
				(entry) =>
					entry.plainDescription!.length > 155 &&
					!entry.plainDescription!.endsWith('…'),
			),
		).toBe(true)
	})

	it('uses REST first and loads one coherent raw snapshot without the Atom feed', async () => {
		const fetchMock = mockRawFetch()
		const timeoutSpy = vi.spyOn(AbortSignal, 'timeout')
		const dictionary = await getAiCodingDictionary()
		expect(githubMocks.getContent).not.toHaveBeenCalled()
		expect(githubMocks.getTree).not.toHaveBeenCalled()
		expect(githubMocks.getBranch).not.toHaveBeenCalled()
		expect(githubMocks.getCommit).toHaveBeenCalledTimes(1)
		expect(githubMocks.getCommit).toHaveBeenCalledWith({
			owner: 'mattpocock',
			repo: 'dictionary-of-ai-coding',
			ref: 'main',
			request: { signal: expect.any(AbortSignal), timeout: 3000 },
		})
		expect(timeoutSpy).toHaveBeenCalledWith(3000)
		expect(feedCalls(fetchMock)).toHaveLength(0)
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
		expect(fetchMock.mock.calls).toHaveLength(3)
		for (const [input, init] of fetchMock.mock.calls) {
			expect(urlOf(input)).toContain(`/${COMMIT_SHA}/`)
			expect(init).toMatchObject({
				next: { revalidate: 3600, tags: ['ai-coding-dictionary'] },
			})
		}
	})

	it('aborts a stalled frontmatter read and falls back to the README entry', async () => {
		const controller = new AbortController()
		const timeoutSpy = vi
			.spyOn(AbortSignal, 'timeout')
			.mockReturnValue(controller.signal)
		const fetchMock = mockRawFetch()
		fetchMock.mockImplementation(async (input, init) => {
			const url = urlOf(input)
			if (url.endsWith('/README.md')) return new Response(readme)
			if (url.endsWith('/dictionary/AI.md')) return new Response(aiFrontmatter)
			const signal = signalOf(init)
			if (!signal) throw new Error('frontmatter request had no bounded signal')
			return new Promise<Response>((_resolve, reject) => {
				signal.addEventListener('abort', () => reject(signal.reason), {
					once: true,
				})
			})
		})
		const dictionaryPromise = getAiCodingDictionary()
		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3))
		controller.abort(new DOMException('frontmatter timed out', 'TimeoutError'))
		await expect(dictionaryPromise).resolves.toMatchObject({
			updatedAt: UPDATED_AT,
			entries: [
				{
					title: 'AI',
					description: 'Frontmatter description for AI',
					aliases: ['Artificial intelligence', 'AI system'],
				},
				{
					title: 'Model',
					description: 'README fallback description for Model.',
					aliases: [],
				},
			],
		})
		expect(timeoutSpy).toHaveBeenCalledTimes(3)
		expect(timeoutSpy).toHaveBeenCalledWith(5000)
	})

	it('uses the feed when REST fails and memoizes that ref', async () => {
		githubMocks.getCommit.mockRejectedValue(new Error('REST unavailable'))
		const fetchMock = mockRawFetch()
		const timeoutSpy = vi.spyOn(AbortSignal, 'timeout')
		await expect(getAiCodingDictionary()).resolves.toMatchObject({
			updatedAt: UPDATED_AT,
		})
		expect(feedCalls(fetchMock)).toHaveLength(1)
		expect(feedCalls(fetchMock)[0]?.[1]).toMatchObject({
			signal: expect.any(AbortSignal),
			next: { revalidate: 3600, tags: ['ai-coding-dictionary'] },
		})
		expect(timeoutSpy.mock.calls.slice(0, 2)).toEqual([[3000], [3000]])
		await getAiCodingDictionary()
		expect(githubMocks.getCommit).toHaveBeenCalledTimes(1)
		expect(feedCalls(fetchMock)).toHaveLength(1)
	})

	it('memoizes REST success for five minutes, then resolves a fresh snapshot', async () => {
		vi.useFakeTimers()
		vi.setSystemTime(0)
		const fetchMock = mockRawFetch()
		const first = await getAiCodingDictionary()
		vi.advanceTimersByTime(MEMO_MS - 1)
		await expect(getAiCodingDictionary()).resolves.toEqual(first)
		expect(githubMocks.getCommit).toHaveBeenCalledTimes(1)
		expect(feedCalls(fetchMock)).toHaveLength(0)
		const nextSha = 'a'.repeat(40)
		githubMocks.getCommit.mockResolvedValue({
			data: {
				sha: nextSha,
				commit: { committer: { date: '2026-07-02T08:46:18Z' } },
			},
		})
		vi.advanceTimersByTime(1)
		await expect(getAiCodingDictionary()).resolves.toMatchObject({
			updatedAt: '2026-07-02T08:46:18.000Z',
		})
		expect(githubMocks.getCommit).toHaveBeenCalledTimes(2)
		expect(
			fetchMock.mock.calls.some(([input]) =>
				urlOf(input).includes(`/${nextSha}/README.md`),
			),
		).toBe(true)
	})

	it.each(['504', 'malformed', 'TimeoutError', 'AbortError'])(
		'serves the last good ref after a full %s failure, warns once per retry window, and recovers',
		async (failure) => {
			vi.useFakeTimers()
			const fetchMock = mockRawFetch()
			const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
			const first = await getAiCodingDictionary()
			githubMocks.getCommit.mockRejectedValue(new Error('REST unavailable'))
			fetchMock.mockImplementation(async (input) => {
				if (urlOf(input).endsWith('/commits/main.atom')) {
					if (failure.endsWith('Error'))
						throw new DOMException('feed aborted', failure)
					return failure === '504'
						? new Response('', { status: 504 })
						: new Response('<feed>invalid</feed>')
				}
				if (urlOf(input).endsWith('/README.md')) return new Response(readme)
				if (urlOf(input).endsWith('/dictionary/AI.md'))
					return new Response(aiFrontmatter)
				return new Response('', { status: 503 })
			})
			vi.advanceTimersByTime(MEMO_MS)
			await expect(
				Promise.all([getAiCodingDictionary(), getAiCodingDictionary()]),
			).resolves.toEqual([first, first])
			await expect(getAiCodingDictionary()).resolves.toEqual(first)
			expect(githubMocks.getCommit).toHaveBeenCalledTimes(2)
			expect(feedCalls(fetchMock)).toHaveLength(1)
			expect(warnSpy).toHaveBeenCalledTimes(1)
			vi.advanceTimersByTime(MEMO_MS - 1)
			await getAiCodingDictionary()
			expect(githubMocks.getCommit).toHaveBeenCalledTimes(2)
			vi.advanceTimersByTime(1)
			await getAiCodingDictionary()
			expect(warnSpy).toHaveBeenCalledTimes(2)
			expect(githubMocks.getCommit).toHaveBeenCalledTimes(3)
			githubMocks.getCommit.mockResolvedValue({ data: commitData })
			vi.advanceTimersByTime(MEMO_MS)
			await expect(getAiCodingDictionary()).resolves.toEqual(first)
			expect(githubMocks.getCommit).toHaveBeenCalledTimes(4)
			expect(feedCalls(fetchMock)).toHaveLength(2)
			expect(warnSpy).toHaveBeenCalledTimes(2)
		},
	)

	it('uses the API author date when the committer date is missing', async () => {
		githubMocks.getCommit.mockResolvedValue({
			data: {
				sha: COMMIT_SHA,
				commit: { committer: null, author: { date: UPDATED_AT } },
			},
		})
		mockRawFetch()
		await expect(getAiCodingDictionary()).resolves.toMatchObject({
			updatedAt: UPDATED_AT,
		})
	})

	it.each([
		{ sha: COMMIT_SHA, commit: { committer: { date: 'not-a-date' } } },
		{ sha: COMMIT_SHA, commit: { committer: null, author: null } },
		{ sha: 'invalid', commit: { committer: { date: UPDATED_AT } } },
	])('falls back to the feed when the API ref is invalid: %j', async (data) => {
		githubMocks.getCommit.mockResolvedValue({ data })
		const fetchMock = mockRawFetch()
		await expect(getAiCodingDictionary()).resolves.toMatchObject({
			updatedAt: UPDATED_AT,
		})
		expect(feedCalls(fetchMock)).toHaveLength(1)
	})

	it.each(['504', 'TimeoutError', 'AbortError'])(
		'throws the original feed error on a cold-start %s when both sources fail',
		async (failure) => {
			githubMocks.getCommit.mockRejectedValue(new Error('REST unavailable'))
			const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
			const error = new DOMException('feed aborted', failure)
			const fetchMock = vi.fn()
			if (failure === '504')
				fetchMock.mockResolvedValue(new Response('', { status: 504 }))
			else fetchMock.mockRejectedValue(error)
			vi.stubGlobal('fetch', fetchMock)
			const result = getAiCodingDictionary()
			if (failure === '504')
				await expect(result).rejects.toThrow(
					'Failed to fetch GitHub commit feed: 504',
				)
			else await expect(result).rejects.toBe(error)
			expect(githubMocks.getCommit).toHaveBeenCalledTimes(1)
			expect(fetchMock).toHaveBeenCalledTimes(1)
			expect(warnSpy).not.toHaveBeenCalled()
		},
	)

	it('fails instead of publishing a made-up source date', async () => {
		githubMocks.getCommit.mockRejectedValue(new Error('REST unavailable'))
		vi.stubGlobal(
			'fetch',
			vi
				.fn()
				.mockResolvedValue(
					new Response('<feed><updated>not-a-date</updated></feed>'),
				),
		)
		await expect(getAiCodingDictionary()).rejects.toThrow(
			'GitHub commit feed did not contain a valid commit and update date',
		)
	})
})
