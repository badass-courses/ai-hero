import { Octokit } from '@octokit/rest'

/**
 * Shared GitHub markdown reader. Fetches a file's text via the GitHub contents
 * API and falls back to the raw host when the API can't serve usable content —
 * either because it is rate-limited (403) or because the file is too large for
 * the contents API (>1MB, which returns `encoding: 'none'` with empty content).
 *
 * Used by both the AI coding dictionary and the github-sourced post sync.
 */

const octokit = new Octokit({
	auth: process.env.GITHUB_TOKEN || process.env.GH_TOKEN || undefined,
	userAgent: 'ai-hero-github-markdown/1.0.0',
})

export type GithubMarkdownFileRef = {
	owner: string
	repo: string
	path: string
	ref: string
	/** Optional ISR revalidate (seconds) applied to the raw-host fallback fetch. */
	revalidate?: number
}

async function fetchFromRawHost(ref: GithubMarkdownFileRef): Promise<string> {
	const { owner, repo, path, ref: gitRef, revalidate } = ref

	const response = await fetch(
		`https://raw.githubusercontent.com/${owner}/${repo}/${gitRef}/${path
			.split('/')
			.map(encodeURIComponent)
			.join('/')}`,
		revalidate ? { next: { revalidate } } : undefined,
	)

	if (!response.ok) {
		throw new Error(
			`Failed to fetch ${owner}/${repo}/${path} fallback: ${response.status}`,
		)
	}

	return response.text()
}

export async function fetchGithubMarkdownFile(
	ref: GithubMarkdownFileRef,
): Promise<string> {
	const { owner, repo, path } = ref

	try {
		const response = await octokit.rest.repos.getContent({
			owner,
			repo,
			path,
			ref: ref.ref,
		})

		const data = response.data
		if (
			!Array.isArray(data) &&
			data.type === 'file' &&
			data.content &&
			data.encoding === 'base64'
		) {
			return Buffer.from(data.content, 'base64').toString('utf8')
		}

		// Large files come back as `encoding: 'none'` with empty content; the raw
		// host serves them fine.
		return fetchFromRawHost(ref)
	} catch (error) {
		const status =
			typeof error === 'object' && error && 'status' in error
				? Number((error as { status?: unknown }).status)
				: undefined

		// Fall back to the raw host on rate-limit; surface anything else (e.g. a
		// 404 for a deleted source file).
		if (status !== 403) throw error

		return fetchFromRawHost(ref)
	}
}
