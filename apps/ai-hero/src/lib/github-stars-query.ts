import { unstable_cache } from 'next/cache'
import { Octokit } from '@octokit/rest'

const STAR_COUNT_TTL_SECONDS = 60 * 60 * 12 // 12 hours

const octokit = new Octokit({
	auth: process.env.GITHUB_TOKEN || process.env.GH_TOKEN || undefined,
	userAgent: 'aihero.dev',
})

const _getCachedStarCount = unstable_cache(
	async (owner: string, repo: string): Promise<number | null> => {
		try {
			const { data } = await octokit.rest.repos.get({ owner, repo })
			return typeof data.stargazers_count === 'number'
				? data.stargazers_count
				: null
		} catch {
			return null
		}
	},
	['github-star-count-v1'],
	{ revalidate: STAR_COUNT_TTL_SECONDS, tags: ['github-stars'] },
)

export async function getRepoStarCount(
	owner: string,
	repo: string,
): Promise<number | null> {
	return _getCachedStarCount(owner, repo)
}
