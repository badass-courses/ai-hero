import crypto from 'node:crypto'
import { revalidateTag } from 'next/cache'
import { courseBuilderAdapter, db } from '@/db'
import { contentResource } from '@/db/schema'
import { log } from '@/server/logger'
import { Octokit } from '@octokit/rest'
import { sql } from 'drizzle-orm'

/**
 * Sync engine for "GitHub-sourced" posts. A post opts in by setting
 * `fields.githubSource` to a markdown file in a GitHub repo (e.g. a skill's
 * SKILL.md). When the source file changes, this updates the post's `body` (and
 * `description` from frontmatter) to match. Everything else about the post —
 * its slug, cover image, attached video, list membership, title — stays
 * CMS-owned and is never touched here.
 *
 * Change detection is a content hash stored in `fields.githubSourceSha`, so a
 * sync that fetches identical content is a no-op.
 */

const octokit = new Octokit({
	auth: process.env.GITHUB_TOKEN || process.env.GH_TOKEN || undefined,
	userAgent: 'ai-hero-github-source-sync/1.0.0',
})

export type GithubSourceRef = {
	owner: string
	repo: string
	path: string
	ref: string
}

/**
 * Parse a `githubSource` field value into a concrete repo file reference.
 * Accepts a GitHub blob URL, a raw.githubusercontent URL, or an
 * `owner/repo/path/to/file.md` shorthand (defaulting to the `main` ref).
 */
export function parseGithubSource(source: string): GithubSourceRef | null {
	const trimmed = source.trim()
	if (!trimmed) return null

	try {
		const url = new URL(trimmed)
		const segments = url.pathname.split('/').filter(Boolean)

		if (url.hostname === 'github.com') {
			// /{owner}/{repo}/blob/{ref}/{...path}
			const [owner, repo, kind, ref, ...rest] = segments
			if (owner && repo && kind === 'blob' && ref && rest.length) {
				return { owner, repo, ref, path: rest.join('/') }
			}
			return null
		}

		if (url.hostname === 'raw.githubusercontent.com') {
			// /{owner}/{repo}/{ref}/{...path}
			const [owner, repo, ref, ...rest] = segments
			if (owner && repo && ref && rest.length) {
				return { owner, repo, ref, path: rest.join('/') }
			}
			return null
		}

		return null
	} catch {
		// Not a URL — fall back to `owner/repo/path` shorthand.
		const segments = trimmed.split('/').filter(Boolean)
		const [owner, repo, ...rest] = segments
		if (owner && repo && rest.length) {
			return { owner, repo, ref: 'main', path: rest.join('/') }
		}
		return null
	}
}

type GithubFile = {
	content?: string
	encoding?: string
}

async function fetchGithubMarkdown(refInfo: GithubSourceRef): Promise<string> {
	const { owner, repo, path, ref } = refInfo

	try {
		const response = await octokit.rest.repos.getContent({
			owner,
			repo,
			path,
			ref,
		})

		if (Array.isArray(response.data) || response.data.type !== 'file') {
			throw new Error(`Expected GitHub file at ${owner}/${repo}/${path}`)
		}

		const file = response.data as GithubFile
		if (!file.content || file.encoding !== 'base64') {
			throw new Error(
				`Expected base64 GitHub file content for ${owner}/${repo}/${path}`,
			)
		}

		return Buffer.from(file.content, 'base64').toString('utf8')
	} catch (error) {
		const status =
			typeof error === 'object' && error && 'status' in error
				? Number((error as { status?: unknown }).status)
				: undefined

		// Fall back to the raw host only on rate-limit, mirroring the dictionary
		// reader; other errors (404, auth) should surface.
		if (status !== 403) throw error

		const response = await fetch(
			`https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${path
				.split('/')
				.map(encodeURIComponent)
				.join('/')}`,
		)

		if (!response.ok) {
			throw new Error(
				`Failed to fetch ${owner}/${repo}/${path} fallback: ${response.status}`,
			)
		}

		return response.text()
	}
}

type ParsedMarkdown = {
	body: string
	description: string | null
}

/**
 * Strip a leading YAML frontmatter block so the page renders the content (not
 * the `---` header), and pull `description` out of it when present.
 */
export function splitFrontmatter(markdown: string): ParsedMarkdown {
	if (!markdown.startsWith('---\n') && !markdown.startsWith('---\r\n')) {
		return { body: markdown, description: null }
	}

	const endIndex = markdown.indexOf('\n---', 4)
	if (endIndex < 0) {
		return { body: markdown, description: null }
	}

	const yaml = markdown.slice(4, endIndex)
	const body = markdown.slice(endIndex + 4).replace(/^\r?\n/, '')

	let description: string | null = null
	for (const line of yaml.split('\n')) {
		const match = line.trim().match(/^description:\s*(.+)$/)
		if (match?.[1]) {
			description = match[1].trim().replace(/^['"]|['"]$/g, '')
			break
		}
	}

	return { body, description }
}

function contentHash(content: string): string {
	return crypto.createHash('sha256').update(content).digest('hex')
}

export type SyncStatus = 'updated' | 'unchanged' | 'skipped' | 'error'

export type SyncResult = {
	id: string
	slug?: string
	status: SyncStatus
	reason?: string
}

type SyncableResource = {
	id: string
	fields: Record<string, unknown> | null
}

function getStringField(
	fields: Record<string, unknown>,
	key: string,
): string | undefined {
	const value = fields[key]
	return typeof value === 'string' ? value : undefined
}

/**
 * Sync a single post from its `githubSource`. No-op when the source is unset,
 * unparseable, or unchanged since the last sync.
 */
export async function syncPostFromGithubSource(
	resource: SyncableResource,
): Promise<SyncResult> {
	const fields = resource.fields ?? {}
	const source = getStringField(fields, 'githubSource')?.trim() ?? ''
	const slug = getStringField(fields, 'slug')

	if (!source) {
		return { id: resource.id, slug, status: 'skipped', reason: 'no githubSource' }
	}

	const refInfo = parseGithubSource(source)
	if (!refInfo) {
		await log.warn('github-source.sync.invalid-source', {
			id: resource.id,
			source,
		})
		return {
			id: resource.id,
			slug,
			status: 'error',
			reason: 'unparseable githubSource',
		}
	}

	try {
		const markdown = await fetchGithubMarkdown(refInfo)
		const hash = contentHash(markdown)

		if (getStringField(fields, 'githubSourceSha') === hash) {
			return { id: resource.id, slug, status: 'unchanged' }
		}

		const { body, description } = splitFrontmatter(markdown)

		const nextFields: Record<string, unknown> = {
			...fields,
			body,
			githubSourceSha: hash,
		}
		// Frontmatter description wins when present; title stays CMS-owned.
		if (description) {
			nextFields.description = description
		}

		await courseBuilderAdapter.updateContentResourceFields({
			id: resource.id,
			fields: nextFields,
		})

		revalidateTag('posts', 'max')

		await log.info('github-source.sync.updated', {
			id: resource.id,
			slug,
			source,
		})

		return { id: resource.id, slug, status: 'updated' }
	} catch (error) {
		await log.error('github-source.sync.failed', {
			id: resource.id,
			slug,
			source,
			error: error instanceof Error ? error.message : String(error),
		})
		return {
			id: resource.id,
			slug,
			status: 'error',
			reason: error instanceof Error ? error.message : 'unknown error',
		}
	}
}

async function getGithubSourcedResources(): Promise<SyncableResource[]> {
	const resources = await db.query.contentResource.findMany({
		where: sql`JSON_EXTRACT(${contentResource.fields}, "$.githubSource") IS NOT NULL`,
	})

	return resources.map((resource) => ({
		id: resource.id,
		fields: (resource.fields as Record<string, unknown> | null) ?? null,
	}))
}

export type SyncAllOptions = {
	/**
	 * Repo-relative file paths that changed (from a push webhook). When provided
	 * and non-empty, only posts whose source path is in the list are synced. An
	 * empty or omitted list syncs every github-sourced post.
	 */
	changedPaths?: string[]
}

export async function syncAllGithubSourcedPosts(
	options: SyncAllOptions = {},
): Promise<SyncResult[]> {
	const resources = await getGithubSourcedResources()
	const changedPaths = options.changedPaths

	const targets =
		changedPaths && changedPaths.length
			? resources.filter((resource) => {
					const source = getStringField(resource.fields ?? {}, 'githubSource')
					const refInfo = source ? parseGithubSource(source) : null
					return refInfo ? changedPaths.includes(refInfo.path) : false
				})
			: resources

	const results: SyncResult[] = []
	for (const resource of targets) {
		results.push(await syncPostFromGithubSource(resource))
	}

	return results
}
