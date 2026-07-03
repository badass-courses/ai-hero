'use server'

import { writeNewLessonToDatabase } from '@/lib/lessons-query'
import { addPostToList } from '@/lib/lists-query'
import { createPost } from '@/lib/posts-query'
import { createResource } from '@/lib/resources/create-resources'
import { getWorkshop } from '@/lib/workshops-query'
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
 * kit's `ContentsItem`. `getWorkshop` loads exactly two levels (top-level rows
 * → section children), which matches the kit's 2-level ContentsList; anything
 * deeper isn't loaded by the query, so a section nested inside a section
 * renders as a plain row (no silent data — the workshop data model doesn't
 * nest deeper in practice).
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
		detail: fields.postType ?? undefined,
		position: row.position ?? 0,
		tier: tierOf(row.metadata),
	}
	if (resource.type === 'section') {
		const children: any[] = [...(resource.resources ?? [])].sort(
			(a, b) => (a.position ?? 0) - (b.position ?? 0),
		)
		item.children = children.map((child) => toContentsItem(child))
	}
	return item
}

/**
 * `bindings.contents.list` for the cms workshop editor — the workshop's child
 * tree (sections/lessons/posts) as `ContentsItem[]`. Loads via the REAL
 * workshop loader (`getWorkshop`, the same nested `resources` query the
 * legacy tree editor consumed) rather than a parallel query. Video and email
 * attachments ride the same join table, so container rows are filtered to the
 * types the tree actually manages.
 */
export async function listWorkshopContents(
	workshopId: string,
): Promise<ContentsItem[]> {
	const { session, ability } = await getServerAuthSession()
	if (!session?.user || !ability.can('update', 'Content')) {
		throw new Error('Unauthorized')
	}

	const workshop = await getWorkshop(workshopId)
	if (!workshop) {
		throw new Error(`Workshop ${workshopId} not found`)
	}

	return [...(workshop.resources ?? [])]
		.filter((row: any) => {
			const type = row.resource?.type
			// videoResource / email join rows share the table; the legacy tree
			// only showed content children.
			return type && !['videoResource', 'email'].includes(type)
		})
		.sort((a: any, b: any) => (a.position ?? 0) - (b.position ?? 0))
		.map((row) => toContentsItem(row))
}

/**
 * `bindings.contents.create` for the cms workshop editor — the "+ New {type}"
 * quick-create (mirrors `createPostInList`). Composes the SAME creation
 * machinery the legacy "Create New" flows ran — `createPost` for posts,
 * `writeNewLessonToDatabase` for lessons, and the generic `createResource`
 * for sections — then attaches the new DRAFT child at the end position via
 * `addPostToList`, the exact join-row write this editor's `contents.add`
 * already uses (tier lands as 'standard', legacy `handleResourceAdd` parity).
 * Every creator slugs its placeholder title with a fresh guid, so repeated
 * untitled children never collide. Returns the new row as a `ContentsItem`.
 */
export async function createWorkshopChild(
	workshopId: string,
	type: string,
): Promise<ContentsItem> {
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
	} else if (type === 'lesson') {
		// The real lesson writer (draft state, `lesson_${guid}` id, `~guid`
		// slug); 'lesson' is the plain default lessonType — exercise/solution
		// variants are authored through their own flows.
		const lesson = await writeNewLessonToDatabase({
			title: 'Untitled lesson',
			lessonType: 'lesson',
			createdById: session.user.id,
		})
		childId = lesson.id
	} else if (type === 'section') {
		// Sections have no bespoke writer — the generic top-level creator the
		// legacy Create-New modal used (draft state, `~guid` slug).
		const section = await createResource({
			type: 'section',
			title: 'Untitled section',
		})
		childId = section.id
	} else {
		throw new Error(`Cannot quick-create a "${type}" in a workshop`)
	}

	const row = await addPostToList({
		postId: childId,
		listId: workshopId,
		metadata: { tier: 'standard' },
	})
	if (!row) {
		throw new Error('Failed to attach the new resource to the workshop')
	}
	return toContentsItem(row)
}
