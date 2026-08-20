import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fetchGithubMarkdownFile = vi.hoisted(() => vi.fn())

vi.mock('next/cache', () => ({
	unstable_cache: <Value>(load: () => Promise<Value>) => load,
}))

vi.mock('@/lib/github-markdown', () => ({
	fetchGithubMarkdownFile,
}))

vi.mock('@/lib/github-source-resilience', () => ({
	getGithubSourceErrorStatus: (error: unknown) => {
		if (typeof error !== 'object' || error === null || !('status' in error)) {
			return null
		}
		return Number(error.status)
	},
	githubSourceAuthMode: 'token',
	githubSourceOctokit: {
		rest: {
			repos: {
				getBranch: vi.fn().mockResolvedValue({
					data: { commit: { commit: {} } },
				}),
			},
			git: {
				getTree: vi.fn().mockResolvedValue({ data: { tree: [] } }),
			},
		},
	},
	readGithubSource: async <Value>(options: {
		request: () => Promise<Value>
	}) => options.request(),
	mapWithConcurrency: async <Input, Output>(
		items: Input[],
		_concurrency: number,
		map: (item: Input, index: number) => Promise<Output>,
	) => Promise.all(items.map(map)),
}))

describe('AI coding dictionary source degradation', () => {
	let warnSpy: { mockRestore: () => void }

	beforeEach(() => {
		vi.resetModules()
		fetchGithubMarkdownFile.mockReset()
		fetchGithubMarkdownFile.mockRejectedValue(new Error('source offline'))
		warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
	})

	afterEach(() => {
		warnSpy.mockRestore()
	})

	it('returns a safe empty dictionary when no source read succeeds', async () => {
		const {
			AI_CODING_DICTIONARY_SOURCE_URL,
			getAiCodingDictionary,
			getAiCodingDictionaryEntry,
		} = await import('./ai-coding-dictionary')

		await expect(getAiCodingDictionary()).resolves.toEqual({
			sections: [],
			entries: [],
			sourceUrl: AI_CODING_DICTIONARY_SOURCE_URL,
			updatedAt: '1970-01-01T00:00:00.000Z',
		})
		await expect(getAiCodingDictionaryEntry('agent')).resolves.toBeNull()
		expect(console.warn).toHaveBeenCalledWith(
			JSON.stringify({
				event: 'github_source.dictionary_degraded',
				schemaVersion: 1,
				outcome: 'empty_fallback',
				status: null,
				authMode: 'token',
				errorCategory: 'source_failure',
			}),
		)
	})

	it('makes a bad preview token explicit before returning the empty fallback', async () => {
		fetchGithubMarkdownFile.mockReset().mockRejectedValue(
			Object.assign(new Error('bad credential with private source detail'), {
				status: 401,
			}),
		)
		const { getAiCodingDictionary } = await import('./ai-coding-dictionary')

		await expect(getAiCodingDictionary()).resolves.toMatchObject({
			sections: [],
			entries: [],
		})
		expect(console.warn).toHaveBeenCalledWith(
			JSON.stringify({
				event: 'github_source.dictionary_degraded',
				schemaVersion: 1,
				outcome: 'empty_fallback',
				status: 401,
				authMode: 'token',
				errorCategory: 'invalid_credential',
			}),
		)
		expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain(
			'private source detail',
		)
	})
})
