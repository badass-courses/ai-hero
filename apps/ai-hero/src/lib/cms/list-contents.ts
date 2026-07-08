'use server'

import { addPostToList, getList } from '@/lib/lists-query'
import { createPost } from '@/lib/posts-query'
import { createResource } from '@/lib/resources/create-resources'
import { ResourceTypeSchema } from '@/lib/resource-types'
import { getServerAuthSession } from '@/server/auth'

import type { ContentsItem, ContentsTier } from '@coursebuilder/ui/cms/manifest'

const TIERS: ContentsTier[] = ['free', 'standard', 'premium', 'vip']

function tierOf(metadata: unknown): ContentsTier | undefined {
	const tier = (metadata as { tier?: string } | null | undefined)?.tier
	return TIERS.includes(tier as ContentsTier)
		? (tier as ContentsTier)
		: undefined
}

/**
 * Map one `contentResourceResource` join row (+ its joined resource) onto the
 * kit's `ContentsItem` (mirrors `workshop-contents.ts`). NOTE: `getList` loads
 * ONE level (`resources: { with: { resource: true } }`), so a section's own
 * children aren't in the payload and section rows render childless — exactly
 * what the legacy tree did with the same loader (`resourceItem.resource
 * .resources ?? []` was always undefined → []). No data is lost: nested rows
 * stay in the DB untouched because reorder writes are keyed by
 * `(childId, previousParentId)` and only cover loaded rows.
 */
function toContentsItem(row: {
	position: number
	metadata?: unknown
	resource?: any
}): ContentsItem {
	const resource = row.resource ?? {}
	const fields = resource.fields ?? {}
	const item: ContentsItem = {
		id: resource.id,
		type: resource.type ?? 'resource',
		title: fields.title ?? fields.slug ?? resource.id,
		slug: fields.slug ?? undefined,
		state: fields.state ?? undefined,
		visibility: fields.visibility ?? undefined,
		description: fields.description ?? undefined,
		detail: fields.postType ?? undefined,
		position: row.position ?? 0,
		tier: tierOf(row.metadata),
	}
	if (resource.type === 'section' && Array.isArray(resource.resources)) {
		const children: any[] = [...resource.resources].sort(
			(a, b) => (a.position ?? 0) - (b.position ?? 0),
		)
		item.children = children.map((child) => toContentsItem(child))
	}
	return item
}

/**
 * `bindings.contents.list` for the cms list editor — the list's child rows as
 * `ContentsItem[]`. Loads via the REAL list loader (`getList`, the same query
 * the legacy `ListResourcesEdit` consumed) rather than a parallel query.
 */
export async function listListContents(
	listId: string,
): Promise<ContentsItem[]> {
	const { session, ability } = await getServerAuthSession()
	if (!session?.user || !ability.can('update', 'Content')) {
		throw new Error('Unauthorized')
	}

	const list = await getList(listId)
	if (!list) {
		throw new Error(`List ${listId} not found`)
	}

	return [...(list.resources ?? [])]
		.sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
		.map((row) => toContentsItem(row))
}

/**
 * `bindings.contents.create` for the cms list editor — the "+ New {type}"
 * quick-create. Open to any KNOWN resource type: `post` composes the SAME
 * server actions the legacy "Create New" modal ran (`createPost` →
 * `addPostToList`) so posts get their bespoke writer; every other valid type
 * (section, lesson, …) goes through the generic `createResource` (draft,
 * `{type}~guid` slug), created as ITSELF — never silently coerced to a post.
 * The type is validated against `ResourceTypeSchema` so a typo/junk value on
 * this exported server action rejects instead of persisting a bad resource.
 * Both attach at tier 'standard'; placeholder titles are guid-slugged so
 * untitled rows never collide.
 */
export async function createInList(
	listId: string,
	type: string = 'post',
): Promise<void> {
	const { session, ability } = await getServerAuthSession()
	if (!session?.user || !ability.can('create', 'Content')) {
		throw new Error('Unauthorized')
	}

	let childId: string
	if (type === 'post') {
		const post = await createPost({
			title: 'Untitled post',
			postType: 'article',
			createdById: session.user.id,
		})
		if (!post) {
			throw new Error('Failed to create post')
		}
		childId = post.id
	} else if (ResourceTypeSchema.safeParse(type).success) {
		// Any known non-post type (section, lesson, …) — created as itself.
		const resource = await createResource({
			type,
			title: `Untitled ${type}`,
		})
		childId = resource.id
	} else {
		throw new Error(`Cannot create an unknown resource type "${type}" in a list`)
	}

	await addPostToList({
		postId: childId,
		listId,
		metadata: { tier: 'standard' },
	})
}
