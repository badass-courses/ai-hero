import { describe, expect, it, vi } from 'vitest'
import {
	createGithubSourceReader,
	isGithubSourceDegradableError,
	mapWithConcurrency,
	resolveGithubAuth,
	type GithubSourceTelemetryEvent,
} from './github-source-resilience'

function githubError(
	status: number,
	headers: Record<string, string> = {},
	message = `GitHub request failed with ${status}`,
) {
	return Object.assign(new Error(message), {
		status,
		response: { headers },
	})
}

describe('resolveGithubAuth', () => {
	it('uses a trimmed GITHUB_TOKEN without exposing it in the result metadata', () => {
		expect(
			resolveGithubAuth({
				GITHUB_TOKEN: '  github-secret  ',
				GH_TOKEN: 'other-secret',
			}),
		).toEqual({
			token: 'github-secret',
			mode: 'token',
			source: 'GITHUB_TOKEN',
		})
	})

	it('reports anonymous mode when no usable token is configured', () => {
		expect(resolveGithubAuth({ GITHUB_TOKEN: '  ', GH_TOKEN: '' })).toEqual({
			token: undefined,
			mode: 'anonymous',
			source: null,
		})
	})
})

describe('isGithubSourceDegradableError', () => {
	it('does not treat a bad credential as a transient source failure', () => {
		expect(isGithubSourceDegradableError(githubError(401))).toBe(false)
		expect(isGithubSourceDegradableError(githubError(403))).toBe(true)
		expect(isGithubSourceDegradableError(githubError(504))).toBe(true)
	})
})

describe('createGithubSourceReader', () => {
	it('degrades a non-retryable 403 and caches a successful fallback', async () => {
		const telemetry: GithubSourceTelemetryEvent[] = []
		const request = vi.fn().mockRejectedValue(githubError(403))
		const fallback = vi.fn().mockResolvedValue('raw README')
		const read = createGithubSourceReader({
			sleep: vi.fn(),
			telemetry: (event) => telemetry.push(event),
		})
		const options = {
			cacheKey: 'readme:private-owner/private-repo/README.md',
			operation: 'readme' as const,
			authMode: 'token' as const,
			request,
			fallback,
			cacheFallback: true,
		}

		await expect(read(options)).resolves.toBe('raw README')
		await expect(read(options)).resolves.toBe('raw README')
		expect(request).toHaveBeenCalledTimes(1)
		expect(fallback).toHaveBeenCalledTimes(1)
		expect(telemetry.find((event) => event.outcome === 'degraded')).toMatchObject({
			status: 403,
			attempt: 1,
		})
		expect(telemetry.some((event) => event.outcome === 'cache_hit')).toBe(true)
	})

	it('uses the anonymous fallback without making an API request', async () => {
		const telemetry: GithubSourceTelemetryEvent[] = []
		const request = vi.fn()
		const anonymousFallback = vi.fn().mockResolvedValue('raw README')
		const read = createGithubSourceReader({
			telemetry: (event) => telemetry.push(event),
		})

		await expect(
			read({
				cacheKey: 'readme:dictionary',
				operation: 'readme',
				authMode: 'anonymous',
				request,
				anonymousFallback,
				cacheFallback: true,
			}),
		).resolves.toBe('raw README')

		expect(request).not.toHaveBeenCalled()
		expect(anonymousFallback).toHaveBeenCalledOnce()
		expect(telemetry.at(-1)).toMatchObject({
			outcome: 'degraded',
			status: null,
			attempt: 0,
			authMode: 'anonymous',
		})
	})

	it('serves stale anonymous raw content after fresh expiry', async () => {
		let now = 0
		const anonymousFallback = vi
			.fn()
			.mockResolvedValueOnce('known-good README')
			.mockRejectedValue(githubError(504))
		const telemetry: GithubSourceTelemetryEvent[] = []
		const read = createGithubSourceReader({
			now: () => now,
			telemetry: (event) => telemetry.push(event),
		})
		const options = {
			cacheKey: 'readme:anonymous-dictionary',
			operation: 'readme' as const,
			authMode: 'anonymous' as const,
			request: vi.fn(),
			anonymousFallback,
			cacheFallback: true,
			cacheTtlMs: 100,
			staleTtlMs: 1_000,
		}

		await expect(read(options)).resolves.toBe('known-good README')
		now = 200
		await expect(read(options)).resolves.toBe('known-good README')
		expect(anonymousFallback).toHaveBeenCalledTimes(2)
		expect(telemetry.at(-1)).toMatchObject({
			outcome: 'stale_fallback',
			status: 504,
			attempt: 0,
			authMode: 'anonymous',
		})
	})

	it('fails an anonymous raw read after the stale window expires', async () => {
		let now = 0
		const unavailable = githubError(504)
		const anonymousFallback = vi
			.fn()
			.mockResolvedValueOnce('known-good README')
			.mockRejectedValue(unavailable)
		const read = createGithubSourceReader({ now: () => now })
		const options = {
			cacheKey: 'readme:expired-anonymous-dictionary',
			operation: 'readme' as const,
			authMode: 'anonymous' as const,
			request: vi.fn(),
			anonymousFallback,
			cacheFallback: true,
			cacheTtlMs: 100,
			staleTtlMs: 1_000,
		}

		await expect(read(options)).resolves.toBe('known-good README')
		now = 1_001
		await expect(read(options)).rejects.toBe(unavailable)
		expect(anonymousFallback).toHaveBeenCalledTimes(2)
	})

	it('does not serve stale anonymous content after a source is deleted', async () => {
		let now = 0
		const notFound = githubError(404)
		const anonymousFallback = vi
			.fn()
			.mockResolvedValueOnce('known-good README')
			.mockRejectedValue(notFound)
		const read = createGithubSourceReader({ now: () => now })
		const options = {
			cacheKey: 'readme:deleted-anonymous-source',
			operation: 'readme' as const,
			authMode: 'anonymous' as const,
			request: vi.fn(),
			anonymousFallback,
			cacheFallback: true,
			cacheTtlMs: 100,
			staleTtlMs: 1_000,
		}

		await expect(read(options)).resolves.toBe('known-good README')
		now = 200
		await expect(read(options)).rejects.toBe(notFound)
		expect(anonymousFallback).toHaveBeenCalledTimes(2)
	})

	it('honors a short Retry-After delay inside the wait budget', async () => {
		const sleep = vi.fn().mockResolvedValue(undefined)
		const request = vi
			.fn()
			.mockRejectedValueOnce(githubError(403, { 'retry-after': '0.25' }))
			.mockResolvedValueOnce('recovered')
		const read = createGithubSourceReader({ sleep })

		await expect(
			read({
				cacheKey: 'readme:short-secondary-limit',
				operation: 'readme',
				authMode: 'token',
				request,
				retryWaitBudgetMs: 500,
			}),
		).resolves.toBe('recovered')

		expect(sleep).toHaveBeenCalledOnce()
		expect(sleep).toHaveBeenCalledWith(250)
		expect(request).toHaveBeenCalledTimes(2)
	})

	it('does not retry early when Retry-After exceeds the wait budget', async () => {
		const sleep = vi.fn().mockResolvedValue(undefined)
		const request = vi.fn().mockRejectedValue(
			githubError(403, { 'retry-after': '5' }),
		)
		const fallback = vi.fn().mockResolvedValue('raw fallback')
		const read = createGithubSourceReader({ sleep })

		await expect(
			read({
				cacheKey: 'readme:long-secondary-limit',
				operation: 'readme',
				authMode: 'token',
				request,
				fallback,
				retryWaitBudgetMs: 500,
			}),
		).resolves.toBe('raw fallback')

		expect(sleep).not.toHaveBeenCalled()
		expect(request).toHaveBeenCalledOnce()
		expect(fallback).toHaveBeenCalledOnce()
	})

	it('uses stale data when Retry-After exceeds the wait budget', async () => {
		let now = 0
		const sleep = vi.fn().mockResolvedValue(undefined)
		const request = vi
			.fn()
			.mockResolvedValueOnce('known-good')
			.mockRejectedValue(
				githubError(403, { 'retry-after': '5' }),
			)
		const read = createGithubSourceReader({ now: () => now, sleep })
		const options = {
			cacheKey: 'readme:long-secondary-limit-stale',
			operation: 'readme' as const,
			authMode: 'token' as const,
			request,
			cacheTtlMs: 100,
			staleTtlMs: 1_000,
			retryWaitBudgetMs: 500,
		}

		await expect(read(options)).resolves.toBe('known-good')
		now = 200
		await expect(read(options)).resolves.toBe('known-good')
		expect(sleep).not.toHaveBeenCalled()
		expect(request).toHaveBeenCalledTimes(2)
	})

	it('retries 504 responses only to the configured limit', async () => {
		const sleep = vi.fn().mockResolvedValue(undefined)
		const request = vi.fn().mockRejectedValue(githubError(504))
		const read = createGithubSourceReader({ sleep })

		await expect(
			read({
				cacheKey: 'branch:dictionary',
				operation: 'branch',
				authMode: 'token',
				request,
				fallback: async () => null,
				maxAttempts: 3,
			}),
		).resolves.toBeNull()

		expect(request).toHaveBeenCalledTimes(3)
		expect(sleep).toHaveBeenNthCalledWith(1, 100)
		expect(sleep).toHaveBeenNthCalledWith(2, 200)
	})

	it('serves a stale successful read when retries are exhausted', async () => {
		let now = 0
		const request = vi
			.fn()
			.mockResolvedValueOnce({ sha: 'known-good' })
			.mockRejectedValue(githubError(504))
		const read = createGithubSourceReader({
			now: () => now,
			sleep: vi.fn().mockResolvedValue(undefined),
		})
		const options = {
			cacheKey: 'tree:dictionary',
			operation: 'tree' as const,
			authMode: 'token' as const,
			request,
			cacheTtlMs: 100,
			staleTtlMs: 1_000,
			maxAttempts: 2,
		}

		await expect(read(options)).resolves.toEqual({ sha: 'known-good' })
		now = 200
		await expect(read(options)).resolves.toEqual({ sha: 'known-good' })
		expect(request).toHaveBeenCalledTimes(3)
	})

	it('does not use stale data to hide a bad credential', async () => {
		let now = 0
		const request = vi
			.fn()
			.mockResolvedValueOnce('known-good')
			.mockRejectedValue(githubError(401))
		const read = createGithubSourceReader({ now: () => now })
		const options = {
			cacheKey: 'readme:dictionary',
			operation: 'readme' as const,
			authMode: 'token' as const,
			request,
			cacheTtlMs: 100,
			staleTtlMs: 1_000,
		}

		await expect(read(options)).resolves.toBe('known-good')
		now = 200
		await expect(read(options)).rejects.toMatchObject({ status: 401 })
		expect(request).toHaveBeenCalledTimes(2)
	})

	it('deduplicates concurrent reads for the same cache key', async () => {
		let release: ((value: string) => void) | undefined
		const pending = new Promise<string>((resolve) => {
			release = resolve
		})
		const request = vi.fn(() => pending)
		const read = createGithubSourceReader()
		const options = {
			cacheKey: 'readme:dictionary',
			operation: 'readme' as const,
			authMode: 'token' as const,
			request,
		}
		const reads = Array.from({ length: 20 }, () => read(options))

		expect(request).toHaveBeenCalledTimes(1)
		release?.('one result')
		await expect(Promise.all(reads)).resolves.toEqual(
			Array.from({ length: 20 }, () => 'one result'),
		)
	})

	it('emits bounded telemetry without request content or error text', async () => {
		const telemetry: GithubSourceTelemetryEvent[] = []
		const read = createGithubSourceReader({
			telemetry: (event) => telemetry.push(event),
		})
		const secret = 'github_pat_super_secret'
		const privatePath = 'private-owner/private-repo/secret.md'

		await read({
			cacheKey: `markdown:${privatePath}`,
			operation: 'markdown',
			authMode: 'token',
			request: async () => {
				throw githubError(403, {}, `${secret} ${privatePath}`)
			},
			fallback: async () => 'safe fallback',
		})

		const serialized = JSON.stringify(telemetry)
		expect(serialized).not.toContain(secret)
		expect(serialized).not.toContain(privatePath)
		expect(telemetry.at(-1)).toMatchObject({
			event: 'github_source.read',
			operation: 'markdown',
			outcome: 'degraded',
			status: 403,
			authMode: 'token',
		})
	})
})

describe('mapWithConcurrency', () => {
	it('bounds source-file fan-out', async () => {
		let active = 0
		let peak = 0

		const results = await mapWithConcurrency(
			Array.from({ length: 12 }, (_, index) => index),
			3,
			async (value) => {
				active += 1
				peak = Math.max(peak, active)
				await new Promise((resolve) => setTimeout(resolve, 1))
				active -= 1
				return value * 2
			},
		)

		expect(peak).toBe(3)
		expect(results).toEqual(Array.from({ length: 12 }, (_, index) => index * 2))
	})

	it('maps explicit undefined inputs without leaving sparse results', async () => {
		const mapper = vi.fn(async (value: number | undefined, index: number) =>
			value === undefined ? `missing-${index}` : String(value),
		)

		const results = await mapWithConcurrency([1, undefined, 3], 2, mapper)

		expect(mapper).toHaveBeenCalledTimes(3)
		expect(mapper).toHaveBeenNthCalledWith(2, undefined, 1)
		expect(results).toEqual(['1', 'missing-1', '3'])
		expect(Object.keys(results)).toEqual(['0', '1', '2'])
	})
})
