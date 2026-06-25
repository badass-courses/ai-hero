import 'server-only'

import { env } from '@/env.mjs'
import { log } from '@/server/logger'

/**
 * ConvertKit (Kit) tag helpers. The core email provider can apply a tag to a
 * subscriber via `subscribeToList({ listType: 'tag', listId })`, but it needs a
 * tag *id* — and it does not expose tag creation. These helpers resolve a tag
 * id by name, creating the tag if it does not exist yet, so callers can use a
 * descriptive name (e.g. `interest_<slug>`) without anyone hand-creating a tag
 * per workshop in the Kit dashboard.
 */

const CK_V3 = 'https://api.convertkit.com/v3'

// Resolved name -> id, warmed once per server instance to avoid re-listing.
const tagIdByName = new Map<string, number>()

async function warmTagCache(): Promise<void> {
	const res = await fetch(
		`${CK_V3}/tags?api_secret=${env.CONVERTKIT_API_SECRET}`,
	)
	if (!res.ok) {
		throw new Error(`Kit list tags failed: ${res.status} ${res.statusText}`)
	}
	const data = (await res.json()) as {
		tags?: Array<{ id: number; name: string }>
	}
	for (const tag of data.tags ?? []) {
		tagIdByName.set(tag.name, tag.id)
	}
}

async function createTag(name: string): Promise<number | null> {
	const res = await fetch(`${CK_V3}/tags`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json; charset=utf-8' },
		body: JSON.stringify({
			api_secret: env.CONVERTKIT_API_SECRET,
			tag: { name },
		}),
	})
	if (!res.ok) {
		throw new Error(`Kit create tag failed: ${res.status} ${res.statusText}`)
	}
	const data = (await res.json()) as { id?: number; tag?: { id?: number } }
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
		if (created != null) tagIdByName.set(name, created)
		return created
	} catch (error) {
		await log.error('kit.tag.ensure.failed', {
			tagName: name,
			error: error instanceof Error ? error.message : String(error),
		})
		return null
	}
}
