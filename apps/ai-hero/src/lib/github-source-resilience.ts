import { Octokit } from '@octokit/rest'

const DEFAULT_CACHE_TTL_MS = 60 * 60 * 1_000
const DEFAULT_STALE_TTL_MS = 24 * 60 * 60 * 1_000
const DEFAULT_MAX_ATTEMPTS = 3
const DEFAULT_MAX_CACHE_ENTRIES = 250
const DEFAULT_RETRY_WAIT_BUDGET_MS = 1_000
const MAX_BACKOFF_DELAY_MS = 1_000

export type GithubAuthMode = 'token' | 'anonymous'
export type GithubSourceOperation =
	| 'readme'
	| 'markdown'
	| 'tree'
	| 'branch'
	| 'repository'

export type GithubSourceTelemetryEvent = {
	event: 'github_source.read'
	schemaVersion: 1
	operation: GithubSourceOperation
	outcome:
		| 'success'
		| 'cache_hit'
		| 'deduplicated'
		| 'retry'
		| 'stale_fallback'
		| 'degraded'
		| 'failed'
	status: number | null
	attempt: number
	authMode: GithubAuthMode
	durationMs: number
}

type GithubAuth = {
	token: string | undefined
	mode: GithubAuthMode
	source: 'GITHUB_TOKEN' | 'GH_TOKEN' | null
}

type CacheEntry = {
	value: unknown
	cachedAt: number
}

type ReaderDependencies = {
	now?: () => number
	sleep?: (milliseconds: number) => Promise<void>
	telemetry?: (event: GithubSourceTelemetryEvent) => void
	maxCacheEntries?: number
}

type GithubSourceReadOptions<T> = {
	cacheKey: string
	operation: GithubSourceOperation
	authMode: GithubAuthMode
	request: () => Promise<T>
	anonymousFallback?: () => Promise<T> | T
	fallback?: (error: unknown) => Promise<T> | T
	cacheFallback?: boolean
	cacheTtlMs?: number
	staleTtlMs?: number
	maxAttempts?: number
	retryWaitBudgetMs?: number
}

export function resolveGithubAuth(
	environment: Record<string, string | undefined> = process.env,
): GithubAuth {
	const githubToken = environment.GITHUB_TOKEN?.trim()
	if (githubToken) {
		return { token: githubToken, mode: 'token', source: 'GITHUB_TOKEN' }
	}

	const ghToken = environment.GH_TOKEN?.trim()
	if (ghToken) {
		return { token: ghToken, mode: 'token', source: 'GH_TOKEN' }
	}

	return { token: undefined, mode: 'anonymous', source: null }
}

const githubAuth = resolveGithubAuth()
const quietOctokitLogger = {
	debug: () => undefined,
	info: () => undefined,
	warn: () => undefined,
	error: () => undefined,
}

/**
 * Shared authenticated GitHub client. Octokit's default request logger includes
 * repository paths and request IDs, so source reads use bounded telemetry below
 * instead.
 */
export const githubSourceOctokit = new Octokit({
	auth: githubAuth.token,
	userAgent: 'ai-hero-github-source/2.0.0',
	request: { timeout: 5_000 },
	log: quietOctokitLogger,
})

export const githubSourceAuthMode = githubAuth.mode

function defaultTelemetry(event: GithubSourceTelemetryEvent) {
	if (process.env.NODE_ENV === 'test') return

	const line = JSON.stringify(event)
	if (
		event.outcome === 'failed' ||
		event.outcome === 'degraded' ||
		event.outcome === 'stale_fallback'
	) {
		console.warn(line)
		return
	}

	if (event.outcome === 'retry' || event.outcome === 'success') {
		console.info(line)
	}
}

export function getGithubSourceErrorStatus(error: unknown): number | null {
	if (typeof error !== 'object' || error === null || !('status' in error)) {
		return null
	}

	const status = Number(error.status)
	return Number.isFinite(status) ? status : null
}

export function isGithubSourceDegradableError(error: unknown): boolean {
	const status = getGithubSourceErrorStatus(error)
	return status === 403 || status === 429 || (status !== null && status >= 500)
}

function getHeaders(error: unknown): Record<string, unknown> {
	if (
		typeof error !== 'object' ||
		error === null ||
		!('response' in error) ||
		typeof error.response !== 'object' ||
		error.response === null ||
		!('headers' in error.response) ||
		typeof error.response.headers !== 'object' ||
		error.response.headers === null
	) {
		return {}
	}

	return error.response.headers as Record<string, unknown>
}

function getRetryDelayMs(
	error: unknown,
	attempt: number,
	remainingWaitBudgetMs: number,
): number | null {
	const status = getGithubSourceErrorStatus(error)
	if (status === null || remainingWaitBudgetMs <= 0) return null

	const headers = getHeaders(error)
	const retryAfterSeconds = Number(headers['retry-after'])
	if (
		(status === 403 || status === 429) &&
		Number.isFinite(retryAfterSeconds) &&
		retryAfterSeconds > 0
	) {
		const retryAfterMs = retryAfterSeconds * 1_000
		return retryAfterMs <= remainingWaitBudgetMs ? retryAfterMs : null
	}

	if (status === 429 || status >= 500) {
		const backoffMs = Math.min(
			100 * 2 ** (attempt - 1),
			MAX_BACKOFF_DELAY_MS,
		)
		return backoffMs <= remainingWaitBudgetMs ? backoffMs : null
	}

	// A primary rate-limit 403 commonly includes x-ratelimit-remaining: 0.
	// Retrying before reset spends compute without creating quota, so degrade.
	return null
}

function delay(milliseconds: number) {
	return new Promise<void>((resolve) => setTimeout(resolve, milliseconds))
}

export function createGithubSourceReader(
	dependencies: ReaderDependencies = {},
) {
	const now = dependencies.now ?? Date.now
	const sleep = dependencies.sleep ?? delay
	const telemetry = dependencies.telemetry ?? defaultTelemetry
	const maxCacheEntries =
		dependencies.maxCacheEntries ?? DEFAULT_MAX_CACHE_ENTRIES
	const cache = new Map<string, CacheEntry>()
	const inFlight = new Map<string, Promise<unknown>>()

	function emit(
		input: Omit<GithubSourceTelemetryEvent, 'event' | 'schemaVersion'>,
	) {
		telemetry({
			event: 'github_source.read',
			schemaVersion: 1,
			...input,
		})
	}

	function cacheValue(cacheKey: string, value: unknown) {
		cache.delete(cacheKey)
		cache.set(cacheKey, { value, cachedAt: now() })

		while (cache.size > maxCacheEntries) {
			const oldestKey = cache.keys().next().value
			if (typeof oldestKey !== 'string') break
			cache.delete(oldestKey)
		}
	}

	return async function readGithubSource<T>(
		options: GithubSourceReadOptions<T>,
	): Promise<T> {
		const startedAt = now()
		const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS
		const staleTtlMs = options.staleTtlMs ?? DEFAULT_STALE_TTL_MS
		const retryWaitBudgetMs = Math.max(
			0,
			Math.floor(
				options.retryWaitBudgetMs ?? DEFAULT_RETRY_WAIT_BUDGET_MS,
			),
		)
		const cached = cache.get(options.cacheKey)
		const cachedAgeMs = cached ? now() - cached.cachedAt : null
		const emitRead = (
			outcome: GithubSourceTelemetryEvent['outcome'],
			status: number | null,
			attempt: number,
		) =>
			emit({
				operation: options.operation,
				outcome,
				status,
				attempt,
				authMode: options.authMode,
				durationMs: now() - startedAt,
			})

		if (cached && cachedAgeMs !== null && cachedAgeMs <= cacheTtlMs) {
			cache.delete(options.cacheKey)
			cache.set(options.cacheKey, cached)
			emitRead('cache_hit', null, 0)
			// SAFETY: one cache key is owned by one typed source-read call site.
			return cached.value as T
		}

		const pending = inFlight.get(options.cacheKey)
		if (pending) {
			emitRead('deduplicated', null, 0)
			// SAFETY: one in-flight key is owned by one typed source-read call site.
			return pending as Promise<T>
		}

		const execute = async () => {
			if (options.authMode === 'anonymous' && options.anonymousFallback) {
				try {
					const value = await options.anonymousFallback()
					if (options.cacheFallback) cacheValue(options.cacheKey, value)
					emitRead('degraded', null, 0)
					return value
				} catch (error) {
					const status = getGithubSourceErrorStatus(error)
					if (cached && cachedAgeMs !== null && cachedAgeMs <= staleTtlMs) {
						emitRead('stale_fallback', status, 0)
						// SAFETY: one cache key is owned by one typed source-read call site.
						return cached.value as T
					}
					emitRead('failed', status, 0)
					throw error
				}
			}

			const maxAttempts = Math.max(
				1,
				Math.floor(options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS),
			)
			let lastError: unknown
			let lastStatus: number | null = null
			let attemptsMade = 0
			let waitedMs = 0

			for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
				attemptsMade = attempt
				try {
					const value = await options.request()
					cacheValue(options.cacheKey, value)
					emitRead('success', null, attempt)
					return value
				} catch (error) {
					lastError = error
					lastStatus = getGithubSourceErrorStatus(error)
					const retryDelayMs = getRetryDelayMs(
						error,
						attempt,
						retryWaitBudgetMs - waitedMs,
					)
					if (retryDelayMs === null || attempt === maxAttempts) break

					emitRead('retry', lastStatus, attempt)
					await sleep(retryDelayMs)
					waitedMs += retryDelayMs
				}
			}

			if (
				cached &&
				cachedAgeMs !== null &&
				cachedAgeMs <= staleTtlMs &&
				isGithubSourceDegradableError(lastError)
			) {
				emitRead('stale_fallback', lastStatus, attemptsMade)
				// SAFETY: one cache key is owned by one typed source-read call site.
				return cached.value as T
			}

			if (options.fallback) {
				try {
					const value = await options.fallback(lastError)
					if (options.cacheFallback) cacheValue(options.cacheKey, value)
					emitRead('degraded', lastStatus, attemptsMade)
					return value
				} catch (fallbackError) {
					emitRead(
					'failed',
					getGithubSourceErrorStatus(fallbackError) ?? lastStatus,
					attemptsMade,
				)
					throw fallbackError
				}
			}

			emitRead('failed', lastStatus, attemptsMade)
			throw lastError
		}

		const result = execute()
		inFlight.set(options.cacheKey, result)
		try {
			return await result
		} finally {
			if (inFlight.get(options.cacheKey) === result) {
				inFlight.delete(options.cacheKey)
			}
		}
	}
}

export const readGithubSource = createGithubSourceReader()

export async function mapWithConcurrency<Input, Output>(
	items: readonly Input[],
	concurrency: number,
	map: (item: Input, index: number) => Promise<Output>,
): Promise<Output[]> {
	if (items.length === 0) return []

	const workerCount = Math.max(
		1,
		Math.min(Math.floor(concurrency), items.length),
	)
	const results = new Array<Output>(items.length)
	let nextIndex = 0

	async function worker() {
		while (nextIndex < items.length) {
			const index = nextIndex
			nextIndex += 1
			const item = items[index]
			if (item === undefined) continue
			results[index] = await map(item, index)
		}
	}

	await Promise.all(Array.from({ length: workerCount }, () => worker()))
	return results
}
