import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	authMode: 'token' as 'token' | 'anonymous',
	authenticatedGet: vi.fn(),
	anonymousGet: vi.fn(),
	logError: vi.fn(),
	logWarn: vi.fn(),
	cachedValues: new Map<string, unknown>(),
}))

vi.mock('next/cache', () => ({
	unstable_cache: (operation: (...args: unknown[]) => Promise<unknown>) => {
		const values = mocks.cachedValues
		return async (...args: unknown[]) => {
			const key = JSON.stringify(args)
			if (values.has(key)) return values.get(key)
			const value = await operation(...args)
			values.set(key, value)
			return value
		}
	},
}))

vi.mock('@octokit/rest', () => ({
	Octokit: class {
		rest = { repos: { get: mocks.anonymousGet } }
	},
}))

vi.mock('@/lib/github-source-resilience', () => ({
	get githubSourceAuthMode() {
		return mocks.authMode
	},
	githubSourceOctokit: {
		rest: { repos: { get: mocks.authenticatedGet } },
	},
	getGithubSourceErrorStatus: (error: unknown) =>
		typeof error === 'object' && error !== null && 'status' in error
			? Number(error.status)
			: null,
}))

vi.mock('@/server/logger', () => ({
	log: {
		error: mocks.logError,
		warn: mocks.logWarn,
	},
}))

import { getRepoStarCount } from './github-stars-query'

function githubError(
	status: number,
	headers: Record<string, string> = {},
): Error & { status: number; response: { headers: Record<string, string> } } {
	return Object.assign(new Error(`GitHub returned ${status}`), {
		status,
		response: { headers },
	})
}

describe('getRepoStarCount', () => {
	beforeEach(() => {
		vi.resetAllMocks()
		mocks.cachedValues.clear()
		vi.useFakeTimers()
		vi.setSystemTime(new Date('2026-11-09T12:00:00Z'))
		mocks.authMode = 'token'
		mocks.logError.mockResolvedValue(undefined)
		mocks.logWarn.mockResolvedValue(undefined)
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it('caches a successful star count', async () => {
		mocks.authenticatedGet.mockResolvedValue({
			data: { stargazers_count: 258_824 },
		})

		await expect(
			getRepoStarCount('mattpocock', 'skills-success'),
		).resolves.toBe(258_824)
		await expect(
			getRepoStarCount('mattpocock', 'skills-success'),
		).resolves.toBe(258_824)

		expect(mocks.authenticatedGet).toHaveBeenCalledOnce()
		expect(mocks.logError).not.toHaveBeenCalled()
	})

	it('uses the public repository API when no token is configured', async () => {
		mocks.authMode = 'anonymous'
		mocks.authenticatedGet.mockResolvedValue({
			data: { stargazers_count: 258_824 },
		})

		await expect(
			getRepoStarCount('mattpocock', 'skills-anonymous'),
		).resolves.toBe(258_824)
		expect(mocks.authenticatedGet).toHaveBeenCalledOnce()
		expect(mocks.anonymousGet).not.toHaveBeenCalled()
	})

	it('retries anonymously when GitHub rejects the configured token', async () => {
		mocks.authenticatedGet.mockRejectedValue(githubError(401))
		mocks.anonymousGet.mockResolvedValue({
			data: { stargazers_count: 258_824 },
		})

		await expect(getRepoStarCount('mattpocock', 'skills-auth')).resolves.toBe(
			258_824,
		)
		expect(mocks.anonymousGet).toHaveBeenCalledWith({
			owner: 'mattpocock',
			repo: 'skills-auth',
		})
		expect(mocks.logWarn).toHaveBeenCalledWith(
			'github-stars.auth.rejected',
			expect.objectContaining({
				status: 401,
				authMode: 'token',
				fallbackAuthMode: 'anonymous',
				success: false,
			}),
		)
	})

	it.each([403, 429])(
		'backs off on %s until reset and logs bounded warning metadata',
		async (status) => {
			mocks.authMode = status === 429 ? 'anonymous' : 'token'
			const repo = `skills-retry-${status}`
			const reset = Date.now() / 1000 + 60
			mocks.authenticatedGet
				.mockRejectedValueOnce(
					githubError(status, {
						authorization: 'Bearer do-not-log-me',
						'x-ratelimit-remaining': '0',
						'x-ratelimit-reset': String(reset),
					}),
				)
				.mockResolvedValueOnce({ data: { stargazers_count: 258_825 } })

			await expect(getRepoStarCount('mattpocock', repo)).resolves.toBeNull()
			await expect(getRepoStarCount('mattpocock', repo)).resolves.toBeNull()
			expect(mocks.authenticatedGet).toHaveBeenCalledOnce()
			vi.advanceTimersByTime(60_000)
			await expect(getRepoStarCount('mattpocock', repo)).resolves.toBe(258_825)
			expect(mocks.authenticatedGet).toHaveBeenCalledTimes(2)
			expect(mocks.logWarn).toHaveBeenCalledWith(
				'github-stars.rate_limited',
				expect.objectContaining({
					status,
					rateLimitRemaining: 0,
					rateLimitResetEpochSeconds: reset,
				}),
			)
			expect(mocks.logError).not.toHaveBeenCalled()
			expect(JSON.stringify(mocks.logWarn.mock.calls)).not.toContain(
				'do-not-log-me',
			)
		},
	)

	it.each([
		['missing', undefined, 300_000],
		['invalid', 'invalid', 300_000],
		['distant', '9999999999', 3_600_000],
	] as const)(
		'bounds backoff for a %s reset',
		async (name, reset, duration) => {
			const headers: Record<string, string> = { 'x-ratelimit-remaining': '0' }
			if (reset !== undefined) headers['x-ratelimit-reset'] = reset
			mocks.authenticatedGet
				.mockRejectedValueOnce(githubError(403, headers))
				.mockResolvedValueOnce({ data: { stargazers_count: 10 } })
			const repo = `skills-reset-${name}`
			await expect(getRepoStarCount('mattpocock', repo)).resolves.toBeNull()
			vi.advanceTimersByTime(duration - 1)
			await expect(getRepoStarCount('mattpocock', repo)).resolves.toBeNull()
			expect(mocks.authenticatedGet).toHaveBeenCalledOnce()
			vi.advanceTimersByTime(1)
			await expect(getRepoStarCount('mattpocock', repo)).resolves.toBe(10)
		},
	)

	it.each([500, 403, 429])(
		'retries ordinary %s failures and logs an error',
		async (status) => {
			mocks.authenticatedGet
				.mockRejectedValueOnce(githubError(status))
				.mockResolvedValueOnce({ data: { stargazers_count: 12 } })
			const repo = `skills-error-${status}`
			await expect(getRepoStarCount('mattpocock', repo)).resolves.toBeNull()
			await expect(getRepoStarCount('mattpocock', repo)).resolves.toBe(12)
			expect(mocks.authenticatedGet).toHaveBeenCalledTimes(2)
			expect(mocks.logError).toHaveBeenCalledWith(
				'github-stars.fetch.failed',
				expect.objectContaining({ status }),
			)
			expect(mocks.logWarn).not.toHaveBeenCalled()
		},
	)

	it.each([403, 500])(
		'serves the last good count after a %s failure',
		async (status) => {
			const repo = `skills-stale-${status}`
			mocks.authenticatedGet.mockResolvedValueOnce({
				data: { stargazers_count: 0 },
			})
			await expect(getRepoStarCount('mattpocock', repo)).resolves.toBe(0)
			// Simulate Next's successful-read cache expiring.
			mocks.cachedValues.clear()
			mocks.authenticatedGet
				.mockRejectedValueOnce(
					githubError(status, {
						'x-ratelimit-remaining': '0',
						'x-ratelimit-reset': String(Date.now() / 1000 + 60),
					}),
				)
				.mockResolvedValueOnce({ data: { stargazers_count: 15 } })
			await expect(getRepoStarCount('mattpocock', repo)).resolves.toBe(0)
			if (status === 403) {
				await expect(getRepoStarCount('mattpocock', repo)).resolves.toBe(0)
				expect(mocks.authenticatedGet).toHaveBeenCalledTimes(2)
				vi.advanceTimersByTime(60_000)
			}
			await expect(getRepoStarCount('mattpocock', repo)).resolves.toBe(15)
		},
	)

	it('backs off when the anonymous token-rejection fallback is rate limited', async () => {
		mocks.authenticatedGet.mockRejectedValue(githubError(401))
		mocks.anonymousGet.mockRejectedValue(
			githubError(429, { 'x-ratelimit-remaining': '0' }),
		)
		await expect(
			getRepoStarCount('mattpocock', 'skills-fallback-block'),
		).resolves.toBeNull()
		await expect(
			getRepoStarCount('mattpocock', 'skills-fallback-block'),
		).resolves.toBeNull()
		expect(mocks.authenticatedGet).toHaveBeenCalledOnce()
		expect(mocks.anonymousGet).toHaveBeenCalledOnce()
		expect(mocks.logWarn).toHaveBeenCalledWith(
			'github-stars.rate_limited',
			expect.objectContaining({ authMode: 'anonymous' }),
		)
		expect(mocks.logError).not.toHaveBeenCalled()
	})

	it('keeps backoff scoped to the owner and repository', async () => {
		mocks.authenticatedGet
			.mockRejectedValueOnce(githubError(403, { 'x-ratelimit-remaining': '0' }))
			.mockResolvedValue({ data: { stargazers_count: 42 } })
		await expect(getRepoStarCount('owner-a', 'scoped')).resolves.toBeNull()
		await expect(getRepoStarCount('owner-b', 'scoped')).resolves.toBe(42)
		await expect(getRepoStarCount('owner-a', 'other')).resolves.toBe(42)
		await expect(getRepoStarCount('owner-a', 'scoped')).resolves.toBeNull()
		expect(mocks.authenticatedGet).toHaveBeenCalledTimes(3)
	})

	it('bounds process-local state by evicting the oldest repository', async () => {
		mocks.authenticatedGet.mockRejectedValue(
			githubError(403, { 'x-ratelimit-remaining': '0' }),
		)
		for (let index = 0; index <= 100; index++) {
			await expect(
				getRepoStarCount('bounded', `repo-${index}`),
			).resolves.toBeNull()
		}
		expect(mocks.authenticatedGet).toHaveBeenCalledTimes(101)
		await expect(getRepoStarCount('bounded', 'repo-100')).resolves.toBeNull()
		expect(mocks.authenticatedGet).toHaveBeenCalledTimes(101)
		await expect(getRepoStarCount('bounded', 'repo-0')).resolves.toBeNull()
		expect(mocks.authenticatedGet).toHaveBeenCalledTimes(102)
	})

	it('does not cache a malformed successful response', async () => {
		mocks.authenticatedGet
			.mockResolvedValueOnce({ data: {} })
			.mockResolvedValueOnce({ data: { stargazers_count: 258_826 } })

		await expect(
			getRepoStarCount('mattpocock', 'skills-malformed'),
		).resolves.toBeNull()
		await expect(
			getRepoStarCount('mattpocock', 'skills-malformed'),
		).resolves.toBe(258_826)

		expect(mocks.authenticatedGet).toHaveBeenCalledTimes(2)
		expect(mocks.logError).toHaveBeenCalledWith(
			'github-stars.fetch.failed',
			expect.objectContaining({
				errorCategory: 'invalid_response',
				status: null,
			}),
		)
	})
})
