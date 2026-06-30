import { env } from '@/env.mjs'

/**
 * Allowlist of repositories a post may source its body from, as `owner/repo`
 * (case-insensitive). This is the single gate shared by:
 *   - the authenticated fetch in `github-source-sync` (so a CMS editor can't
 *     point `githubSource` at an arbitrary repo the GITHUB_TOKEN can read), and
 *   - the push webhook (so only pushes from these repos trigger a sync).
 *
 * Configure with `GITHUB_SOURCE_ALLOWED_REPOS` — a comma-separated list of
 * `owner/repo` entries, e.g. `mattpocock/skills, acme/docs`. Entries that
 * aren't a well-formed `owner/repo` are ignored. When the variable is unset or
 * has no valid entries, the list falls back to {@link DEFAULT_ALLOWED_SOURCE_REPOS}.
 */
export const DEFAULT_ALLOWED_SOURCE_REPOS = ['mattpocock/skills']

const OWNER_REPO = /^[^/\s]+\/[^/\s]+$/

function parseAllowedRepos(raw: string | undefined): string[] {
	const configured = (raw ?? '')
		.split(',')
		.map((entry) => entry.trim().toLowerCase())
		.filter((entry) => OWNER_REPO.test(entry))

	const list = configured.length ? configured : DEFAULT_ALLOWED_SOURCE_REPOS
	return Array.from(new Set(list))
}

/** The resolved, normalized allowlist (lowercased `owner/repo`, deduped). */
export const ALLOWED_SOURCE_REPOS = parseAllowedRepos(
	env.GITHUB_SOURCE_ALLOWED_REPOS,
)

/** True when `ownerRepo` ("owner/repo") is allowed. Case-insensitive. */
export function isAllowedSourceRepo(ownerRepo: string): boolean {
	return ALLOWED_SOURCE_REPOS.includes(ownerRepo.trim().toLowerCase())
}
