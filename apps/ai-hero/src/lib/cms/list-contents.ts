'use server'

import { revalidateTag } from 'next/cache'
import { db } from '@/db'
import { addPostToList, getListWithSections } from '@/lib/lists-query'
import {
	createPost,
	executePostCreationSideEffects,
} from '@/lib/posts-query'
import {
	createResource,
	executeResourceCreationSideEffects,
} from '@/lib/resources/create-resources'
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
 * kit's `ContentsItem` (mirrors `workshop-contents.ts`). Loads via
 * `getListWithSections`, which joins one level deeper so a `section` row
 * carries its own children — otherwise a skill moved into a section vanishes
 * from the editor tree (its list-level row is gone, and childless sections
 * hide it). Reorder writes stay keyed by `(childId, parentId, previousParentId)`
 * so the now-visible nested rows are fully reorderable.
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

	const list = await getListWithSections(listId)
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
 *
 * Creation and attachment are wrapped in a single database transaction:
 * either both the child resource and the join relation are persisted, or
 * neither is created (preventing orphaned draft resources if attach fails).
 * External side effects (TypeSense, Inngest, tag revalidation) run only
 * post-commit.
 */
export async function createInList(
	listId: string,
	type: string = 'post',
	title?: string,
	description?: string,
): Promise<void> {
	const { session, ability } = await getServerAuthSession()
	const user = session?.user
	if (
		!user ||
		!ability.can('create', 'Content') ||
		!ability.can('update', 'Content')
	) {
		throw new Error('Unauthorized')
	}

	const trimmedTitle = title?.trim()

	if (type !== 'post' && !ResourceTypeSchema.safeParse(type).success) {
		throw new Error(`Cannot create an unknown resource type "${type}" in a list`)
	}

	const result = await db.transaction(async (tx) => {
		let childId: string
		let createdPost: any = null
		let createdResource: any = null

		if (type === 'post') {
			const post = await createPost(
				{
					title: trimmedTitle || 'Untitled post',
					postType: 'article',
					createdById: user.id,
				},
				{ tx, deferSideEffects: true },
			)
			if (!post) {
				throw new Error('Failed to create post')
			}
			childId = post.id
			createdPost = post
		} else {
			// Any known non-post type (section, lesson, …) — created as itself. A
			// caller-supplied title/description (e.g. the section-name modal) wins;
			// otherwise a guid-slugged placeholder so untitled rows never collide.
			const resource = await createResource(
				{
					type,
					title: trimmedTitle || `Untitled ${type}`,
					description: description?.trim() || undefined,
				},
				{ tx, deferSideEffects: true },
			)
			childId = resource.id
			createdResource = resource
		}

		await addPostToList({
			postId: childId,
			listId,
			metadata: { tier: 'standard' },
			tx,
			revalidate: false,
		})

		return { type, createdPost, createdResource }
	})

	// Post-commit side effects: executed only after both records are durable
	if (result.type === 'post' && result.createdPost) {
		await executePostCreationSideEffects(result.createdPost)
	} else if (result.createdResource) {
		await executeResourceCreationSideEffects(result.createdResource)
	}

	revalidateTag('lists', 'max')
	revalidateTag(listId, 'max')
}
