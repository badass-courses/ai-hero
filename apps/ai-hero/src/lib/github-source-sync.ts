import crypto from 'node:crypto'
import { revalidateTag } from 'next/cache'
import { courseBuilderAdapter, db } from '@/db'
import { contentResource } from '@/db/schema'
import { fetchGithubMarkdownFile } from '@/lib/github-markdown'
import { upsertPostToTypeSense } from '@/lib/typesense-query'
import { log } from '@/server/logger'
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
// Repos a post may source its body from. The CMS-controlled `githubSource` is
// validated against this before any authenticated fetch, so an editor can't
// mirror arbitrary repos the GITHUB_TOKEN can read into a post. Because every
// source resolves to the same repo, matching webhook changes by path alone is
// unambiguous.
const ALLOWED_SOURCE_REPOS = ['mattpocock/skills']

function isAllowedRepo(ref: GithubSourceRef): boolean {
	return ALLOWED_SOURCE_REPOS.includes(`${ref.owner}/${ref.repo}`.toLowerCase())
}

function safeDecode(segment: string): string {
	try {
		return decodeURIComponent(segment)
	} catch {
		return segment
	}
}

export function parseGithubSource(source: string): GithubSourceRef | null {
	const trimmed = source.trim()
	if (!trimmed) return null

	try {
		const url = new URL(trimmed)
		// pathname segments are percent-encoded; decode so the resulting path
		// matches the plain paths GitHub sends in push webhooks (and that the API
		// expects).
		const segments = url.pathname.split('/').filter(Boolean).map(safeDecode)

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

type ParsedMarkdown = {
	body: string
	description: string | null
}

/**
 * Strip a leading YAML frontmatter block so the page renders the content (not
 * the `---` header), and pull a top-level `description` out of it when present.
 *
 * Only treats the leading block as frontmatter when it opens at the very start
 * and closes with a `---` on its own line, so a body thematic break or a
 * `----` rule isn't mistaken for the closing fence. Only top-level (unindented)
 * keys are read, so a nested `description:` can't become the post description.
 */
export function splitFrontmatter(markdown: string): ParsedMarkdown {
	const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/)
	if (!match) {
		return { body: markdown, description: null }
	}

	const yaml = match[1] ?? ''
	const body = markdown.slice(match[0].length)

	let description: string | null = null
	for (const line of yaml.split('\n')) {
		const fieldMatch = line.match(/^description:[ \t]*(.+?)[ \t\r]*$/)
		if (fieldMatch?.[1]) {
			description = fieldMatch[1].replace(/^['"]|['"]$/g, '')
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

	if (!isAllowedRepo(refInfo)) {
		await log.warn('github-source.sync.repo-not-allowed', {
			id: resource.id,
			source,
			repo: `${refInfo.owner}/${refInfo.repo}`,
		})
		return {
			id: resource.id,
			slug,
			status: 'error',
			reason: 'source repo not allowed',
		}
	}

	try {
		const markdown = await fetchGithubMarkdownFile(refInfo)
		const hash = contentHash(markdown)

		if (getStringField(fields, 'githubSourceSha') === hash) {
			return { id: resource.id, slug, status: 'unchanged' }
		}

		const { body, description } = splitFrontmatter(markdown)

		// Only write the fields this sync owns. The adapter merges these onto a
		// fresh read of the row, so a concurrent CMS edit to title/slug/cover is
		// preserved rather than clobbered by a stale snapshot.
		const nextFields: Record<string, unknown> = {
			body,
			githubSourceSha: hash,
		}
		// Description follows the source (title stays CMS-owned): use the
		// frontmatter value, and clear a previously-synced one when the source
		// drops it, so the description never goes stale against the file.
		nextFields.description = description ?? null

		const updated = await courseBuilderAdapter.updateContentResourceFields({
			id: resource.id,
			fields: nextFields,
		})

		// Keep search in sync with the new body, matching every other body-write
		// path. A typesense failure must not fail the sync.
		try {
			if (updated) {
				await upsertPostToTypeSense(updated, 'save')
			}
		} catch (error) {
			await log.error('github-source.sync.typesense-failed', {
				id: resource.id,
				slug,
				error: error instanceof Error ? error.message : String(error),
			})
		}

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
		// Scoped to posts (the feature owns post bodies only). `<> ''` also
		// excludes a missing key (JSON_UNQUOTE(NULL) is NULL, and NULL <> '' is
		// not true), so posts saved with an empty githubSource — which the form
		// persists by default — don't get scanned every run.
		where: sql`${contentResource.type} = 'post' AND JSON_UNQUOTE(JSON_EXTRACT(${contentResource.fields}, "$.githubSource")) <> ''`,
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
