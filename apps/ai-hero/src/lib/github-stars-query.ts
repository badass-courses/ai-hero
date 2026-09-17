import { unstable_cache } from 'next/cache'
import { Octokit } from '@octokit/rest'
import {
	getGithubSourceErrorStatus,
	githubSourceAuthMode,
	githubSourceOctokit,
	type GithubAuthMode,
} from '@/lib/github-source-resilience'
import { log } from '@/server/logger'

const STAR_COUNT_TTL_SECONDS = 60 * 60 * 12 // 12 hours

const anonymousOctokit = new Octokit({
	userAgent: 'ai-hero-github-stars/1.0.0',
	request: { timeout: 5_000 },
})

class InvalidGithubStarResponseError extends Error {
	constructor() {
		super('GitHub repository response did not include a numeric star count')
		this.name = 'InvalidGithubStarResponseError'
	}
}

function getRateLimitMetadata(error: unknown): {
	rateLimitRemaining: number | null
	rateLimitResetEpochSeconds: number | null
} {
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
		return { rateLimitRemaining: null, rateLimitResetEpochSeconds: null }
	}

	const headers = error.response.headers as Record<string, unknown>
	const remaining = Number(headers['x-ratelimit-remaining'])
	const reset = Number(headers['x-ratelimit-reset'])
	return {
		rateLimitRemaining: Number.isFinite(remaining) ? remaining : null,
		rateLimitResetEpochSeconds: Number.isFinite(reset) ? reset : null,
	}
}

function errorCategory(error: unknown): string {
	if (error instanceof InvalidGithubStarResponseError) return 'invalid_response'

	const status = getGithubSourceErrorStatus(error)
	if (status === 401) return 'auth_rejected'
	if (status === 403) return 'forbidden_or_rate_limited'
	if (status === 429) return 'rate_limited'
	if (status !== null && status >= 500) return 'github_unavailable'
	if (status !== null) return 'http_error'
	return 'request_error'
}

function failureMetadata(
	owner: string,
	repo: string,
	authMode: GithubAuthMode,
	error: unknown,
) {
	return {
		source: 'github',
		component: 'github-stars-query',
		action: 'repository.fetch',
		success: false,
		repository: `${owner}/${repo}`,
		authMode,
		status: getGithubSourceErrorStatus(error),
		errorCategory: errorCategory(error),
		...getRateLimitMetadata(error),
	}
}

async function readStarCount(
	client: Pick<typeof githubSourceOctokit, 'rest'>,
	owner: string,
	repo: string,
): Promise<number> {
	const { data } = await client.rest.repos.get({ owner, repo })
	if (typeof data.stargazers_count !== 'number') {
		throw new InvalidGithubStarResponseError()
	}
	return data.stargazers_count
}

async function fetchRepoStarCount(
	owner: string,
	repo: string,
): Promise<number> {
	try {
		return await readStarCount(githubSourceOctokit, owner, repo)
	} catch (error) {
		if (
			githubSourceAuthMode === 'token' &&
			getGithubSourceErrorStatus(error) === 401
		) {
			await log
				.warn('github-stars.auth.rejected', {
					...failureMetadata(owner, repo, 'token', error),
					fallbackAuthMode: 'anonymous',
				})
				.catch(() => undefined)

			try {
				return await readStarCount(anonymousOctokit, owner, repo)
			} catch (anonymousError) {
				await log
					.error(
						'github-stars.fetch.failed',
						failureMetadata(owner, repo, 'anonymous', anonymousError),
					)
					.catch(() => undefined)
				throw anonymousError
			}
		}

		await log
			.error(
				'github-stars.fetch.failed',
				failureMetadata(owner, repo, githubSourceAuthMode, error),
			)
			.catch(() => undefined)
		throw error
	}
}

// The cached operation only resolves with a real count. Failures throw through
// unstable_cache, so a transient GitHub error cannot become 12 hours of null.
const _getCachedStarCount = unstable_cache(
	fetchRepoStarCount,
	['github-star-count-v2'],
	{ revalidate: STAR_COUNT_TTL_SECONDS, tags: ['github-stars'] },
)

export async function getRepoStarCount(
	owner: string,
	repo: string,
): Promise<number | null> {
	try {
		return await _getCachedStarCount(owner, repo)
	} catch {
		// The page can safely omit the count. This catch stays outside the cache
		// boundary so the next render retries instead of serving a cached null.
		return null
	}
}
