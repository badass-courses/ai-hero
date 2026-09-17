import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	authMode: 'token' as 'token' | 'anonymous',
	authenticatedGet: vi.fn(),
	anonymousGet: vi.fn(),
	logError: vi.fn(),
	logWarn: vi.fn(),
}))

vi.mock('next/cache', () => ({
	unstable_cache: (operation: (...args: unknown[]) => Promise<unknown>) => {
		const values = new Map<string, unknown>()
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
		vi.clearAllMocks()
		mocks.authMode = 'token'
		mocks.logError.mockResolvedValue(undefined)
		mocks.logWarn.mockResolvedValue(undefined)
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

	it('does not cache a failed read and logs only bounded response metadata', async () => {
		const sensitiveHeaders = {
			authorization: 'Bearer do-not-log-me',
			'x-ratelimit-remaining': '0',
			'x-ratelimit-reset': '1789084800',
		}
		mocks.authenticatedGet
			.mockRejectedValueOnce(githubError(403, sensitiveHeaders))
			.mockResolvedValueOnce({ data: { stargazers_count: 258_825 } })

		await expect(
			getRepoStarCount('mattpocock', 'skills-retry'),
		).resolves.toBeNull()
		await expect(getRepoStarCount('mattpocock', 'skills-retry')).resolves.toBe(
			258_825,
		)

		expect(mocks.authenticatedGet).toHaveBeenCalledTimes(2)
		expect(mocks.logError).toHaveBeenCalledWith(
			'github-stars.fetch.failed',
			expect.objectContaining({
				status: 403,
				rateLimitRemaining: 0,
				rateLimitResetEpochSeconds: 1_789_084_800,
			}),
		)
		expect(JSON.stringify(mocks.logError.mock.calls)).not.toContain(
			'do-not-log-me',
		)
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
