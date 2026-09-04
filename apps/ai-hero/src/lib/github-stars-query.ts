import { unstable_cache } from 'next/cache'
import {
	githubSourceAuthMode,
	githubSourceOctokit,
	isGithubSourceDegradableError,
	readGithubSource,
} from '@/lib/github-source-resilience'

const STAR_COUNT_TTL_SECONDS = 60 * 60 * 12 // 12 hours

const _getCachedStarCount = unstable_cache(
	async (owner: string, repo: string): Promise<number | null> => {
		return readGithubSource({
			cacheKey: `repository:${owner}/${repo}`,
			operation: 'repository',
			authMode: githubSourceAuthMode,
			cacheTtlMs: STAR_COUNT_TTL_SECONDS * 1_000,
			anonymousFallback: async () => null,
			request: async () => {
				const { data } = await githubSourceOctokit.rest.repos.get({
					owner,
					repo,
				})
				return typeof data.stargazers_count === 'number'
					? data.stargazers_count
					: null
			},
			fallback: async (error) => {
				if (!isGithubSourceDegradableError(error)) throw error
				return null
			},
		})
	},
	['github-star-count-v1'],
	{ revalidate: STAR_COUNT_TTL_SECONDS, tags: ['github-stars'] },
)

export async function getRepoStarCount(
	owner: string,
	repo: string,
): Promise<number | null> {
	try {
		return await _getCachedStarCount(owner, repo)
	} catch {
		return null
	}
}
