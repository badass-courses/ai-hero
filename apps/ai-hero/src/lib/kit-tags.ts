import 'server-only'

import { env } from '@/env.mjs'
import { log } from '@/server/logger'

/**
 * ConvertKit (Kit) tag id resolution by name, creating the tag if it doesn't
 * exist. The core email provider can *apply* a tag via
 * `subscribeToList({ listType: 'tag', listId })`, but it needs a tag id and does
 * not expose tag creation (its `createConvertkitTag` is internal and its
 * `tagSubscriber` is a no-op stub). This app helper fills only that gap.
 *
 * TODO(altitude): the right home for this is `@coursebuilder/core`'s convertkit
 * provider (fix `tagSubscriber` to resolve-or-create + apply). That's a
 * separate package release, so this lives in-app for now.
 */

const CK_V3 = 'https://api.convertkit.com/v3'

// Bound each Kit call so a stalled endpoint can't hang the request path. On
// timeout fetch rejects with a TimeoutError, caught like any other failure
// (ensureKitTagId logs and returns null — tagging is best-effort).
const KIT_TIMEOUT_MS = 8_000

// Resolved name -> id. Process-local cache. ConvertKit v3 GET /tags returns the
// full list (not paginated). Concurrent first-misses share one list request via
// `warmPromise`; a cross-instance create race is resolved by re-listing on
// create conflict, so both instances converge on the same existing tag id.
const tagIdByName = new Map<string, number>()
let warmPromise: Promise<void> | null = null

async function fetchTagList(): Promise<void> {
	// List tags is an account-level GET, which Kit v3 authenticates with api_key
	// (api_secret 401s here); subscriber mutations below use api_secret.
	const res = await fetch(
		`${CK_V3}/tags?api_key=${encodeURIComponent(env.CONVERTKIT_API_KEY)}`,
		{ signal: AbortSignal.timeout(KIT_TIMEOUT_MS) },
	)
	const body = await res.text()
	if (!res.ok) {
		throw new Error(
			`Kit list tags failed: ${res.status} ${res.statusText} ${body.slice(0, 200)}`,
		)
	}
	const data = JSON.parse(body) as {
		tags?: Array<{ id: number; name: string }>
	}
	for (const tag of data.tags ?? []) {
		tagIdByName.set(tag.name, tag.id)
	}
}

/** Memoized list fetch so concurrent first-misses don't all hit the API. */
function warmTagCache(force = false): Promise<void> {
	if (force) warmPromise = null
	if (!warmPromise) {
		warmPromise = fetchTagList().catch((error) => {
			warmPromise = null // let the next call retry rather than caching the failure
			throw error
		})
	}
	return warmPromise
}

/** Returns the new tag id, or null on conflict/failure (caller re-lists). */
async function createTag(name: string): Promise<number | null> {
	const res = await fetch(`${CK_V3}/tags`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json; charset=utf-8' },
		body: JSON.stringify({
			api_secret: env.CONVERTKIT_API_SECRET,
			tag: { name },
		}),
		signal: AbortSignal.timeout(KIT_TIMEOUT_MS),
	})
	const body = await res.text()
	if (!res.ok) {
		// Most likely a concurrent create from another request/instance; the
		// caller re-lists to find the now-existing tag.
		await log.warn('kit.tag.create.conflict', {
			tagName: name,
			status: res.status,
			body: body.slice(0, 200),
		})
		return null
	}
	const data = JSON.parse(body) as { id?: number; tag?: { id?: number } }
	return data.id ?? data.tag?.id ?? null
}

/**
 * Resolve a Kit tag id by name, creating the tag if needed. Best-effort:
 * returns null on failure so callers can treat tagging as non-blocking.
 */
export async function ensureKitTagId(name: string): Promise<number | null> {
	const cached = tagIdByName.get(name)
	if (cached != null) return cached

	try {
		await warmTagCache()
		const existing = tagIdByName.get(name)
		if (existing != null) return existing

		const created = await createTag(name)
		if (created != null) {
			tagIdByName.set(name, created)
			return created
		}

		// Create returned no id (e.g. it already existed via a concurrent create).
		// Re-list once and look it up.
		await warmTagCache(true)
		return tagIdByName.get(name) ?? null
	} catch (error) {
		await log.error('kit.tag.ensure.failed', {
			tagName: name,
			error: error instanceof Error ? error.message : String(error),
		})
		return null
	}
}
