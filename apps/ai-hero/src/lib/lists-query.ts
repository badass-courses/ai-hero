'use server'

import { revalidatePath, revalidateTag, unstable_cache } from 'next/cache'
import { courseBuilderAdapter, db } from '@/db'
import {
	contentResource,
	contentResourceResource,
	contentResourceTag as contentResourceTagTable,
} from '@/db/schema'
import { getServerAuthSession } from '@/server/auth'
import { log } from '@/server/logger'
import { guid } from '@coursebuilder/utils/guid'
import { subject } from '@casl/ability'
import slugify from '@sindresorhus/slugify'
import { and, asc, desc, eq, or, sql } from 'drizzle-orm'
import { z } from 'zod'

import type { ContentResourceResource } from '@coursebuilder/core/schemas'
import { publishedAtStamp } from '@coursebuilder/ui/cms/resource-state'

import { filterSectionedResources } from './list-sections'
import { ListSchema, type List, type ListUpdate } from './lists'
import { PostSchema } from './posts'
import { updatePost } from './posts-query'
import { deletePostInTypeSense, upsertPostToTypeSense } from './typesense-query'

export async function createList(input: {
	title: string
	listType: string
	description?: string
}) {
	const { session, ability } = await getServerAuthSession()
	if (!session?.user?.id || !ability.can('create', 'Content')) {
		throw new Error('Unauthorized')
	}
	const listGuid = guid()
	const newListId = `list_${listGuid}`

	await courseBuilderAdapter.createContentResource({
		id: newListId,
		type: 'list',
		fields: {
			title: input.title,
			description: input.description,
			type: input.listType,
			state: 'draft',
			visibility: 'unlisted',
			slug: `${slugify(input.title)}~${guid()}`,
		},
		createdById: session.user.id,
	})

	const list = await getList(newListId)

	try {
		list && (await upsertPostToTypeSense(list, 'save'))
	} catch (e) {
		void log.error('list.typesense.index.error', {
			listId: newListId,
			error: e instanceof Error ? e.message : String(e),
		})
	}

	revalidateTag('lists', 'max')
	return list
}

export async function getAllLists() {
	const lists = await db.query.contentResource.findMany({
		where: eq(contentResource.type, 'list'),
		with: {
			resources: {
				with: {
					resource: true,
				},
				orderBy: asc(contentResourceResource.position),
			},
			tags: {
				with: {
					tag: true,
				},
				orderBy: asc(contentResourceTagTable.position),
			},
		},
		orderBy: desc(contentResource.createdAt),
	})

	// Parse per-row so one malformed list is skipped and logged rather than
	// throwing and failing the whole query — list-all consumers (e.g. the
	// read-only CLI hitting /api/resources?type=list) otherwise get a 500
	// because a single bad record breaks the entire response.
	const parsed: List[] = []
	for (const list of lists) {
		const result = ListSchema.safeParse(list)
		if (result.success) {
			parsed.push(result.data)
		} else {
			void log.error('list.parse.error', {
				listId: list.id,
				error: result.error.message,
				source: 'getAllLists',
			})
		}
	}

	return parsed
}

export async function getList(listIdOrSlug: string) {
	const list = await db.query.contentResource.findFirst({
		where: and(
			or(
				eq(
					sql`JSON_EXTRACT (${contentResource.fields}, "$.slug")`,
					listIdOrSlug,
				),
				eq(contentResource.id, listIdOrSlug),
			),
			eq(contentResource.type, 'list'),
		),
		with: {
			resources: {
				with: {
					resource: true,
				},
				orderBy: asc(contentResourceResource.position),
			},
			tags: {
				with: {
					tag: true,
				},
				orderBy: asc(contentResourceTagTable.position),
			},
		},
	})

	const listParsed = ListSchema.safeParse(list)
	if (!listParsed.success) {
		void log.error('list.parse.error', {
			listIdOrSlug,
			error: listParsed.error.message,
		})
		return null
	}

	return listParsed.data
}

/**
 * Like {@link getList}, but joins one level deeper so a `section` resource
 * carries its child resources. Kept separate from `getList` on purpose: the
 * shared loader stays one-level so the cms list editor keeps rendering section
 * rows childless (see `cms/list-contents.ts`), while surfaces that group items
 * under sections — currently /skills — opt into the deeper payload here.
 */
export async function getListWithSections(listIdOrSlug: string) {
	const list = await db.query.contentResource.findFirst({
		where: and(
			or(
				eq(
					sql`JSON_EXTRACT (${contentResource.fields}, "$.slug")`,
					listIdOrSlug,
				),
				eq(contentResource.id, listIdOrSlug),
			),
			eq(contentResource.type, 'list'),
		),
		with: {
			resources: {
				with: {
					resource: {
						with: {
							resources: {
								with: {
									resource: true,
								},
								orderBy: asc(contentResourceResource.position),
							},
						},
					},
				},
				orderBy: asc(contentResourceResource.position),
			},
			tags: {
				with: {
					tag: true,
				},
				orderBy: asc(contentResourceTagTable.position),
			},
		},
	})

	const listParsed = ListSchema.safeParse(list)
	if (!listParsed.success) {
		void log.error('list.parse.error', {
			listIdOrSlug,
			error: listParsed.error.message,
			source: 'getListWithSections',
		})
		return null
	}

	return listParsed.data
}

const _getCachedListForPost = unstable_cache(
	async (slugOrId: string) => getListForPost(slugOrId),
	['posts-v3'],
	{ revalidate: 3600, tags: ['posts'] },
)

export async function getCachedListForPost(slugOrId: string) {
	const result = await _getCachedListForPost(slugOrId)
	return result ? reviveDates(result) : null
}

function reviveDates(obj: any): any {
	if (obj === null || obj === undefined) return obj
	if (typeof obj === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(obj)) {
		const d = new Date(obj)
		return isNaN(d.getTime()) ? obj : d
	}
	if (Array.isArray(obj)) return obj.map(reviveDates)
	if (typeof obj === 'object') {
		const result: any = {}
		for (const [key, value] of Object.entries(obj)) {
			result[key] = reviveDates(value)
		}
		return result
	}
	return obj
}

export async function getListForPost(postIdOrSlug: string) {
	// Find the (oldest) list the post belongs to — either as a DIRECT child, or
	// nested under a `section` that itself sits in the list. The section path is
	// what keeps a post's list nav alive after it's moved into a section: we
	// resolve the list by "where the section lives", not by any stored parent
	// hint on the post.
	const result = await db.execute(sql`
		WITH target AS (
			SELECT id FROM ${contentResource}
			WHERE id = ${postIdOrSlug}
			OR JSON_EXTRACT(fields, '$.slug') = ${postIdOrSlug}
			LIMIT 1
		)
		SELECT list.id AS list_id
		FROM ${contentResource} AS list
		WHERE list.type = 'list'
			AND (
				EXISTS (
					SELECT 1 FROM ${contentResourceResource} AS direct
					WHERE direct.resourceOfId = list.id
						AND direct.resourceId = (SELECT id FROM target)
				)
				OR EXISTS (
					SELECT 1
					FROM ${contentResourceResource} AS sectionInList
					JOIN ${contentResourceResource} AS postInSection
						ON postInSection.resourceOfId = sectionInList.resourceId
					WHERE sectionInList.resourceOfId = list.id
						AND postInSection.resourceId = (SELECT id FROM target)
				)
			)
		ORDER BY list.createdAt ASC
		LIMIT 1
	`)

	const listId = (result.rows[0] as any)?.list_id as string | undefined
	if (!listId) {
		void log.debug('list.query.not-found', {
			postIdOrSlug,
		})
		return null
	}

	// Load the list section-aware and trim to what should render publicly, so
	// the shared `ResourceListView` shows sections (and the current post under
	// its section) with unlisted/unpublished siblings hidden.
	const deep = await getListWithSections(listId)
	if (!deep) return null

	return {
		...deep,
		resources: filterSectionedResources(
			deep.resources as ContentResourceResource[],
		),
	}
}

export async function getMinimalListForNavigation(listIdOrSlug: string) {
	const result = await db.execute(sql`
        SELECT
            list.id,
            list.type,
            list.fields,
            list.createdAt,
            list.updatedAt,
            list.deletedAt,
            list.createdById,
            list.organizationId,
            list.createdByOrganizationMembershipId,
            resources.id AS resource_id,
            resources.type AS resource_type,
            JSON_OBJECT(
                'title', JSON_EXTRACT(resources.fields, '$.title'),
                'slug', JSON_EXTRACT(resources.fields, '$.slug'),
                'state', JSON_EXTRACT(resources.fields, '$.state')
            ) AS resource_fields,
            relation.position
        FROM ${contentResource} AS list
        LEFT JOIN ${contentResourceResource} AS relation
            ON list.id = relation.resourceOfId
        LEFT JOIN ${contentResource} AS resources
            ON resources.id = relation.resourceId
        WHERE (list.id = ${listIdOrSlug} OR JSON_EXTRACT(list.fields, '$.slug') = ${listIdOrSlug})
            AND list.type = 'list'
        ORDER BY relation.position ASC
    `)

	if (result.rows.length === 0) {
		return null
	}

	const firstRow = result.rows[0] as any
	const list = {
		id: firstRow.id,
		type: firstRow.type,
		fields: firstRow.fields,
		createdAt: firstRow.createdAt,
		updatedAt: firstRow.updatedAt,
		deletedAt: firstRow.deletedAt,
		createdById: firstRow.createdById,
		organizationId: firstRow.organizationId,
		createdByOrganizationMembershipId:
			firstRow.createdByOrganizationMembershipId,
		resources: result.rows
			.filter((row: any) => row.resource_id)
			.map((row: any) => ({
				resource: {
					id: row.resource_id,
					type: row.resource_type,
					fields: row.resource_fields,
				},
				position: row.position,
				resourceId: row.resource_id,
				resourceOfId: firstRow.id,
			})),
		tags: [], // Include empty tags array to satisfy ListSchema
	}

	return ListSchema.parse(list)
}

export async function addPostToList({
	postId,
	listId,
	metadata,
}: {
	postId: string
	listId: string
	metadata?: {
		tier?: 'standard' | 'premium' | 'vip'
	}
}) {
	const { ability } = await getServerAuthSession()
	if (!ability.can('update', 'Content')) {
		throw new Error('Unauthorized')
	}

	const list = await db.query.contentResource.findFirst({
		where: eq(contentResource.id, listId),
		with: {
			resources: true,
		},
	})

	if (!list) throw new Error('List not found')

	await db.insert(contentResourceResource).values({
		resourceOfId: list.id,
		resourceId: postId,
		position: list.resources.length,
		metadata,
	})

	return db.query.contentResourceResource.findFirst({
		where: and(
			eq(contentResourceResource.resourceOfId, listId),
			eq(contentResourceResource.resourceId, postId),
		),
		with: {
			resource: true,
		},
	})
}

export async function removePostFromList({
	postId,
	listId,
}: {
	postId: string
	listId: string
}) {
	const { ability } = await getServerAuthSession()
	if (!ability.can('update', 'Content')) {
		throw new Error('Unauthorized')
	}

	const list = await db.query.contentResource.findFirst({
		where: eq(contentResource.id, listId),
		with: {
			resources: {
				with: {
					resource: {
						with: {
							resources: {
								with: {
									resource: true,
								},
							},
						},
					},
				},
			},
		},
	})

	if (!list) throw new Error('List not found')

	// Find the resource to remove - could be in top level or in a section
	const resourceToRemove = list.resources.find(
		(r) =>
			r.resourceId === postId ||
			r.resource.resources?.some(
				(childResource) => childResource.resourceId === postId,
			),
	)

	if (!resourceToRemove) throw new Error('Resource not found in list')

	// If the resource is directly in the list
	if (resourceToRemove.resourceId === postId) {
		await db
			.delete(contentResourceResource)
			.where(
				and(
					eq(contentResourceResource.resourceOfId, list.id),
					eq(contentResourceResource.resourceId, postId),
				),
			)
	} else {
		// If the resource is in a section
		await db
			.delete(contentResourceResource)
			.where(
				and(
					eq(contentResourceResource.resourceOfId, resourceToRemove.resourceId),
					eq(contentResourceResource.resourceId, postId),
				),
			)
	}
}

export async function updateList(
	input: ListUpdate,
	action: 'save' | 'publish' | 'archive' | 'unpublish' = 'save',
	revalidate = true,
) {
	const { session, ability } = await getServerAuthSession()
	const user = session?.user

	const currentList = await getList(input.id)

	if (!currentList) {
		throw new Error(`Post with id ${input.id} not found.`)
	}

	if (!user || !ability.can(action, subject('Content', currentList))) {
		throw new Error('Unauthorized')
	}

	// Slugs are intentionally NOT regenerated when the title changes — only an
	// explicit edit to the slug field changes the slug (same policy as
	// updatePost). This keeps published URLs stable when an author tweaks a
	// title.
	let listSlug = currentList.fields.slug

	if (
		input.fields.slug !== undefined &&
		input.fields.slug !== currentList.fields.slug
	) {
		// An omitted slug (undefined) is a title-only edit and preserves the
		// current slug; an explicitly cleared slug is rejected rather than
		// silently ignored, since persisting an empty slug breaks the page URL.
		if (!input.fields.slug) {
			throw new Error('Slug is required')
		}
		listSlug = input.fields.slug
	}

	try {
		await upsertPostToTypeSense(currentList, action)
	} catch (e) {
		void log.error('list.typesense.update.error', {
			listId: currentList.id,
			action,
			error: e instanceof Error ? e.message : String(e),
		})
	}

	revalidate && revalidateTag('lists', 'max')

	return courseBuilderAdapter.updateContentResourceFields({
		id: currentList.id,
		fields: {
			...currentList.fields,
			...input.fields,
			slug: listSlug,
			// Stamp fields.publishedAt on the transition INTO 'published' (or
			// backfill a missing stamp) — same policy as updatePost.
			...publishedAtStamp(input.fields.state, currentList.fields),
		},
	})
}

export async function deleteList(id: string) {
	const { session, ability } = await getServerAuthSession()
	const user = session?.user

	const list = ListSchema.nullish().parse(
		await db.query.contentResource.findFirst({
			where: eq(contentResource.id, id),
			with: {
				resources: true,
			},
		}),
	)

	if (!list) {
		throw new Error(`Post with id ${id} not found.`)
	}

	if (!user || !ability.can('delete', subject('Content', list))) {
		throw new Error('Unauthorized')
	}

	if (list.resources.length > 0) {
		throw new Error('List has resources, please remove them first.')
	}

	await db
		.delete(contentResourceResource)
		.where(eq(contentResourceResource.resourceOfId, id))

	await db.delete(contentResource).where(eq(contentResource.id, id))

	await deletePostInTypeSense(list.id)

	revalidateTag('lists', 'max')
	revalidateTag(id, 'max')
	revalidatePath('/lists')

	return true
}

export async function updateListItemFields(
	itemId: string,
	fields: Record<string, any>,
) {
	const { ability } = await getServerAuthSession()
	if (!ability.can('update', 'Content')) {
		throw new Error('Unauthorized')
	}
	const item = await db.query.contentResource.findFirst({
		where: eq(contentResource.id, itemId),
	})

	if (!item) throw new Error('item not found')

	let result
	switch (item.type) {
		case 'post': {
			const parsedPost = PostSchema.parse(item)
			result = await updatePost(
				{
					id: item.id,
					fields: { ...parsedPost.fields, ...fields },
				},
				'save',
			)
			break
		}
		case 'list': {
			const parsedList = ListSchema.parse(item)
			result = await updateList(
				{
					id: item.id,
					fields: { ...parsedList.fields, ...fields },
					resources: parsedList.resources,
				},
				'save',
			)
			break
		}
		default: {
			result = await courseBuilderAdapter.updateContentResourceFields({
				id: item.id,
				fields: {
					...item.fields,
					...fields,
					...(fields.title && item.fields?.title !== fields.title
						? { slug: `${slugify(fields.title)}~${item.id.split('-')[1]}` }
						: {}),
				},
			})
			// Sections are structural, not searchable content: skip the TypeSense
			// upsert (and its revalidatePostsGraph side-effect). Indexing one both
			// pollutes search and adds latency to the section edit-save that
			// otherwise makes the editor feel frozen.
			if (item.type !== 'section') {
				await upsertPostToTypeSense(result as any, 'save')
			}
		}
	}

	return result
}
