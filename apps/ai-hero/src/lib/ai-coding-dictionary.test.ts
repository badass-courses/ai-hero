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

let getAiCodingDictionary: typeof import('./ai-coding-dictionary').getAiCodingDictionary

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

function signalOf(init: unknown) {
	return typeof init === 'object' && init && 'signal' in init
		? (init as { signal?: AbortSignal }).signal
		: undefined
}

describe('AI Coding Dictionary GitHub source', () => {
	beforeEach(async () => {
		// Each test starts with a cold module; calls within a test share its fallback.
		vi.resetModules()
		const dictionaryModule = await import('./ai-coding-dictionary')
		getAiCodingDictionary = dictionaryModule.getAiCodingDictionary
		githubMocks.getBranch.mockReset().mockRejectedValue({ status: 403 })
		githubMocks.getContent.mockReset().mockRejectedValue({ status: 403 })
		githubMocks.getTree.mockReset().mockRejectedValue({ status: 403 })
	})

	afterEach(() => {
		vi.unstubAllGlobals()
		vi.restoreAllMocks()
	})

	it('stores full SEO text separately without changing main UI/RSS descriptions', async () => {
		const full = 'Engineering vocabulary '.repeat(20).trim()
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: unknown) => {
				const url = urlOf(input)
				if (url.endsWith('/commits/main.atom')) return new Response(commitFeed)
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

	it('aborts a stalled frontmatter read and falls back to the README entry', async () => {
		const controller = new AbortController()
		const timeoutSpy = vi
			.spyOn(AbortSignal, 'timeout')
			.mockReturnValue(controller.signal)
		const fetchMock = vi.fn(async (input: unknown, init?: unknown) => {
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
				const signal = signalOf(init)
				if (!signal) {
					throw new Error('frontmatter request had no bounded signal')
				}

				return new Promise<Response>((_resolve, reject) => {
					signal.addEventListener(
						'abort',
						() => reject(signal.reason ?? new Error('aborted')),
						{ once: true },
					)
				})
			}

			throw new Error(`Unexpected fetch: ${url}`)
		})
		vi.stubGlobal('fetch', fetchMock)

		const dictionaryPromise = getAiCodingDictionary()
		await vi.waitFor(() => {
			expect(
				fetchMock.mock.calls.some(([input]) =>
					urlOf(input).endsWith(`/${COMMIT_SHA}/dictionary/Model.md`),
				),
			).toBe(true)
		})
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
					rawBody: 'README fallback description for Model.',
				},
			],
		})
		expect(timeoutSpy).toHaveBeenCalledTimes(3)
		expect(timeoutSpy).toHaveBeenCalledWith(3000)
		expect(timeoutSpy).toHaveBeenCalledWith(5000)
	})

	it.each(['504', 'malformed'])(
		'reuses the last good snapshot when the feed is %s and recovers on success',
		async (failure) => {
			const nextSha = 'a'.repeat(40)
			const nextDate = '2026-07-02T08:46:18.000Z'
			const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
			const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
			let feedReads = 0
			const fetchMock = vi.fn(async (input: unknown) => {
				const url = urlOf(input)
				if (url.endsWith('/commits/main.atom')) {
					feedReads++
					if (feedReads === 2) {
						return failure === '504'
							? new Response('unavailable', { status: 504 })
							: new Response('<feed>invalid</feed>')
					}
					return new Response(
						feedReads === 1
							? commitFeed
							: commitFeed
									.replace(COMMIT_SHA, nextSha)
									.replaceAll('2026-07-01', '2026-07-02'),
					)
				}
				if (url.endsWith('/README.md')) return new Response(readme)
				return new Response(aiFrontmatter)
			})
			vi.stubGlobal('fetch', fetchMock)

			const first = await getAiCodingDictionary()
			fetchMock.mockClear()
			await expect(getAiCodingDictionary()).resolves.toEqual(first)
			expect(warnSpy).toHaveBeenCalledTimes(1)
			expect(errorSpy).not.toHaveBeenCalled()
			expect(
				fetchMock.mock.calls
					.slice(1)
					.every(([input]) => urlOf(input).includes(`/${COMMIT_SHA}/`)),
			).toBe(true)

			await expect(getAiCodingDictionary()).resolves.toMatchObject({
				updatedAt: nextDate,
			})
			expect(
				fetchMock.mock.calls.some(([input]) =>
					urlOf(input).includes(`/${nextSha}/README.md`),
				),
			).toBe(true)
			expect(warnSpy).toHaveBeenCalledTimes(1)
		},
	)

	it.each(['TimeoutError', 'AbortError'])(
		'reuses the last good snapshot when the feed rejects with %s',
		async (errorName) => {
			const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
			let failFeed = false
			const controller = new AbortController()
			const timeoutSpy = vi.spyOn(AbortSignal, 'timeout')
			const fetchMock = vi.fn(async (input: unknown, init?: unknown) => {
				const url = urlOf(input)
				if (url.endsWith('/commits/main.atom')) {
					if (!failFeed) return new Response(commitFeed)
					const signal = signalOf(init)
					if (!signal) throw new Error('feed request had no bounded signal')
					return new Promise<Response>((_resolve, reject) => {
						signal.addEventListener('abort', () => reject(signal.reason), {
							once: true,
						})
					})
				}
				if (url.endsWith('/README.md')) return new Response(readme)
				return new Response(aiFrontmatter)
			})
			vi.stubGlobal('fetch', fetchMock)
			const first = await getAiCodingDictionary()
			failFeed = true
			timeoutSpy.mockReturnValueOnce(controller.signal)
			const fallback = getAiCodingDictionary()
			expect(timeoutSpy).toHaveBeenLastCalledWith(3000)
			controller.abort(new DOMException('feed aborted', errorName))

			await expect(fallback).resolves.toEqual(first)
			expect(warnSpy).toHaveBeenCalledTimes(1)
		},
	)

	it.each(['504', 'TimeoutError', 'AbortError'])(
		'throws on a cold-start %s instead of inventing a source ref',
		async (failure) => {
			const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
			const error = new DOMException('feed aborted', failure)
			const fetchMock = vi.fn()
			if (failure === '504') {
				fetchMock.mockResolvedValue(new Response('unavailable', { status: 504 }))
			} else {
				fetchMock.mockRejectedValue(error)
			}
			vi.stubGlobal('fetch', fetchMock)

			const result = getAiCodingDictionary()
			if (failure === '504') {
				await expect(result).rejects.toThrow(
					'Failed to fetch GitHub commit feed: 504',
				)
			} else {
				await expect(result).rejects.toBe(error)
			}
			expect(fetchMock).toHaveBeenCalledTimes(1)
			expect(warnSpy).not.toHaveBeenCalled()
		},
	)

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
