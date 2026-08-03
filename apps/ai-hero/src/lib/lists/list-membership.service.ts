/**
 * List membership over HTTP: which resources a list holds, in what order, and
 * inside which section. The CMS reaches this through the server actions in
 * `lists-query.ts`, which authenticate from a cookie session; this service
 * takes an ability instead, so a token-authenticated API route can do the same
 * work. Shaped after `lists.service.ts` in epic-product-engineer, with the
 * nesting ai-hero lists actually have — an item may hang off the list itself
 * or off one of its sections, and that is where the old code got subtle.
 */
import { revalidateTag } from 'next/cache'
import { type AppAbility } from '@/ability'
import { db } from '@/db'
import { contentResource, contentResourceResource } from '@/db/schema'
import { and, asc, eq, sql } from 'drizzle-orm'
import { z } from 'zod'

export class ListMembershipError extends Error {
	constructor(
		message: string,
		public statusCode: number = 400,
		public code: string = 'LIST_MEMBERSHIP_ERROR',
		public details?: unknown,
	) {
		super(message)
		this.name = 'ListMembershipError'
	}
}

export const AddItemInputSchema = z.object({
	resourceId: z.string().min(1),
	/** A section id to nest under. Omit to add at the top level of the list. */
	parentId: z.string().min(1).optional(),
	metadata: z
		.object({ tier: z.string().optional() })
		.passthrough()
		.optional(),
})

export const MoveItemsInputSchema = z.object({
	items: z
		.array(
			z.object({
				resourceId: z.string().min(1),
				/** Omit to reorder in place; pass the list id to pull out of a section. */
				parentId: z.string().min(1).optional(),
				position: z.number().int().min(0),
			}),
		)
		.min(1),
})

/** A `contentResourceResource` row joined to the resource it points at. */
export type MembershipRow = {
	resourceId: string
	position: number
	resource?: {
		id: string
		type: string
		resources?: MembershipRow[] | null
	} | null
}

export type ItemLocation = {
	/** The list itself, or the section the item hangs off. */
	parentId: string
	position: number
}

/**
 * Where an item sits in a list tree, or null when the list doesn't hold it.
 * Top level wins over a section: the same resource can appear in both, and the
 * list-level row is the one the editor shows.
 */
export function locateItem(
	listId: string,
	rows: MembershipRow[],
	resourceId: string,
): ItemLocation | null {
	for (const row of rows) {
		if (row.resourceId === resourceId) {
			return { parentId: listId, position: row.position }
		}
	}

	for (const row of rows) {
		for (const child of row.resource?.resources ?? []) {
			if (child.resourceId === resourceId) {
				return { parentId: row.resourceId, position: child.position }
			}
		}
	}

	return null
}

/** Rows directly under `parentId`, whether that is the list or one of its sections. */
export function siblingsOf(
	listId: string,
	rows: MembershipRow[],
	parentId: string,
): MembershipRow[] {
	if (parentId === listId) return rows
	return rows.find((row) => row.resourceId === parentId)?.resource?.resources ?? []
}

/** Append position for a new row: one past the highest taken, never negative. */
export function nextPosition(siblings: MembershipRow[]): number {
	return siblings.reduce((max, row) => Math.max(max, row.position + 1), 0)
}

/** The list plus two levels — enough to see sections and what they hold. */
async function loadListTree(listIdOrSlug: string) {
	return db.query.contentResource.findFirst({
		where: and(
			eq(contentResource.type, 'list'),
			sql`(${contentResource.id} = ${listIdOrSlug} OR JSON_EXTRACT(${contentResource.fields}, "$.slug") = ${listIdOrSlug})`,
		),
		with: {
			resources: {
				with: {
					resource: {
						with: {
							resources: {
								with: { resource: true },
								orderBy: asc(contentResourceResource.position),
							},
						},
					},
				},
				orderBy: asc(contentResourceResource.position),
			},
		},
	})
}

/**
 * 403, not 401: the route has already established there IS a credential, so a
 * refusal here means a valid token without the ability — the same distinction
 * `/api/resources` draws, and the one that tells an agent not to retry.
 */
function assertCanUpdate(ability: AppAbility) {
	if (ability.cannot('update', 'Content')) {
		throw new ListMembershipError('Forbidden', 403, 'FORBIDDEN')
	}
}

function parseOrThrow<T extends z.ZodTypeAny>(schema: T, data: unknown) {
	const parsed = schema.safeParse(data)
	if (!parsed.success) {
		throw new ListMembershipError(
			'Invalid input',
			400,
			'INVALID_INPUT',
			parsed.error.issues,
		)
	}
	return parsed.data as z.infer<T>
}

async function requireList(listIdOrSlug: string) {
	const list = await loadListTree(listIdOrSlug)
	if (!list) {
		throw new ListMembershipError('List not found', 404, 'LIST_NOT_FOUND')
	}
	return list
}

function revalidateList(listId: string) {
	revalidateTag('lists', 'max')
	revalidateTag(listId, 'max')
}

/**
 * Put a resource in a list, or in one of its sections when `parentId` is given.
 * Appends after the last sibling; existing rows keep their positions, so a
 * caller wanting a specific order follows with `moveListItems`.
 */
export async function addItemToList({
	listIdOrSlug,
	data,
	ability,
}: {
	listIdOrSlug: string
	data: unknown
	ability: AppAbility
}) {
	assertCanUpdate(ability)
	const input = parseOrThrow(AddItemInputSchema, data)
	const list = await requireList(listIdOrSlug)

	const resource = await db.query.contentResource.findFirst({
		where: eq(contentResource.id, input.resourceId),
	})
	if (!resource) {
		throw new ListMembershipError('Resource not found', 404, 'RESOURCE_NOT_FOUND')
	}

	const rows = list.resources as MembershipRow[]
	const parentId = input.parentId ?? list.id

	if (parentId !== list.id && !rows.some((row) => row.resourceId === parentId)) {
		throw new ListMembershipError(
			'Parent section is not in this list',
			404,
			'PARENT_NOT_IN_LIST',
		)
	}

	const siblings = siblingsOf(list.id, rows, parentId)
	if (siblings.some((row) => row.resourceId === input.resourceId)) {
		throw new ListMembershipError(
			'Resource is already in this list',
			409,
			'RESOURCE_ALREADY_IN_LIST',
		)
	}

	await db.insert(contentResourceResource).values({
		resourceOfId: parentId,
		resourceId: input.resourceId,
		position: nextPosition(siblings),
		metadata: input.metadata,
	})

	revalidateList(list.id)

	return db.query.contentResourceResource.findFirst({
		where: and(
			eq(contentResourceResource.resourceOfId, parentId),
			eq(contentResourceResource.resourceId, input.resourceId),
		),
		with: { resource: true },
	})
}

/** Take a resource out of a list, wherever in the tree it sits. */
export async function removeItemFromList({
	listIdOrSlug,
	resourceId,
	ability,
}: {
	listIdOrSlug: string
	resourceId: string
	ability: AppAbility
}) {
	assertCanUpdate(ability)
	const list = await requireList(listIdOrSlug)

	const location = locateItem(
		list.id,
		list.resources as MembershipRow[],
		resourceId,
	)
	if (!location) {
		throw new ListMembershipError(
			'Resource is not in this list',
			404,
			'RESOURCE_NOT_IN_LIST',
		)
	}

	await db
		.delete(contentResourceResource)
		.where(
			and(
				eq(contentResourceResource.resourceOfId, location.parentId),
				eq(contentResourceResource.resourceId, resourceId),
			),
		)

	revalidateList(list.id)

	return { resourceId, ...location }
}

/**
 * Reorder items and move them between sections in one transaction. Every move
 * is resolved against the current tree first, so a batch naming an item the
 * list doesn't hold fails before anything is written.
 */
export async function moveListItems({
	listIdOrSlug,
	data,
	ability,
}: {
	listIdOrSlug: string
	data: unknown
	ability: AppAbility
}) {
	assertCanUpdate(ability)
	const input = parseOrThrow(MoveItemsInputSchema, data)
	const list = await requireList(listIdOrSlug)
	const rows = list.resources as MembershipRow[]

	const planned = input.items.map((item) => {
		const current = locateItem(list.id, rows, item.resourceId)
		if (!current) {
			throw new ListMembershipError(
				`Resource ${item.resourceId} is not in this list`,
				404,
				'RESOURCE_NOT_IN_LIST',
			)
		}

		const toParentId = item.parentId ?? current.parentId
		if (
			toParentId !== list.id &&
			!rows.some((row) => row.resourceId === toParentId)
		) {
			throw new ListMembershipError(
				`Parent ${toParentId} is not a section of this list`,
				404,
				'PARENT_NOT_IN_LIST',
			)
		}

		return {
			resourceId: item.resourceId,
			fromParentId: current.parentId,
			toParentId,
			position: item.position,
		}
	})

	await db.transaction(async (trx) => {
		for (const move of planned) {
			await trx
				.update(contentResourceResource)
				.set({ resourceOfId: move.toParentId, position: move.position })
				.where(
					and(
						eq(contentResourceResource.resourceOfId, move.fromParentId),
						eq(contentResourceResource.resourceId, move.resourceId),
					),
				)
		}
	})

	revalidateList(list.id)

	return planned
}
