/**
 * List membership over HTTP: which resources a list holds, in what order, and
 * inside which section. The CMS reaches this through the server actions in
 * `lists-query.ts`, which authenticate from a cookie session; this service
 * takes an ability instead, so a token-authenticated API route can do the same
 * work. Shaped after `lists.service.ts` in epic-product-engineer, with the
 * nesting ai-hero lists actually have — an item may hang off the list itself
 * or off one of its sections, and that is where the old code got subtle.
 *
 * The tree is strictly two levels: sections sit directly under the list, and
 * only non-sections sit under a section. Every write path enforces that, so a
 * request cannot express a self-parent, a section inside a section, or a
 * parent the renderers would never reach.
 */
import { revalidateTag } from 'next/cache'
import { type AppAbility } from '@/ability'
import { db } from '@/db'
import { contentResource, contentResourceResource } from '@/db/schema'
import { canUpdateContentRelation } from '@/server/pat-scopes'
import { and, asc, eq, sql } from 'drizzle-orm'
import { z } from 'zod'

import {
	AddListItemInputSchema,
	MoveListItemsInputSchema,
} from './list-membership-contracts'

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

export type PlannedWrite = {
	resourceId: string
	fromParentId: string
	toParentId: string
	position: number
}

type SimRow = {
	resourceId: string
	fromParentId: string
	fromPosition: number
}

/**
 * Resolve a move batch against the loaded tree into the exact row updates to
 * apply — pure, so the tricky part is unit-testable. The batch is SIMULATED in
 * order on in-memory sibling arrays, then every touched parent is renumbered
 * densely from the final arrangement. Positions therefore stay unique and gap
 * free no matter what the caller sends: a duplicate target position is an
 * insertion order, not a collision, and a position past the end appends. The
 * returned writes include the sibling renumbering, not just the named items.
 */
export function planMoves(
	listId: string,
	rows: MembershipRow[],
	moves: { resourceId: string; parentId?: string; position: number }[],
): PlannedWrite[] {
	// Sibling arrays per parent, in loaded (position) order.
	const byParent = new Map<string, SimRow[]>()
	const simRow = (row: MembershipRow, fromParentId: string): SimRow => ({
		resourceId: row.resourceId,
		fromParentId,
		fromPosition: row.position,
	})
	byParent.set(
		listId,
		rows.map((row) => simRow(row, listId)),
	)
	const typeOf = new Map<string, string>()
	for (const row of rows) {
		if (row.resource?.type) typeOf.set(row.resourceId, row.resource.type)
		if (row.resource?.type === 'section') {
			byParent.set(
				row.resourceId,
				(row.resource.resources ?? []).map((child) =>
					simRow(child, row.resourceId),
				),
			)
			for (const child of row.resource.resources ?? []) {
				if (child.resource?.type && !typeOf.has(child.resourceId)) {
					typeOf.set(child.resourceId, child.resource.type)
				}
			}
		}
	}

	const locate = (resourceId: string) => {
		// Same preference as locateItem: the top-level placement wins when a
		// resource sits in more than one place.
		for (const [parentId, siblings] of [
			[listId, byParent.get(listId)!] as const,
			...[...byParent.entries()].filter(([parentId]) => parentId !== listId),
		]) {
			const index = siblings.findIndex((row) => row.resourceId === resourceId)
			if (index !== -1) return { parentId, index }
		}
		return null
	}

	for (const move of moves) {
		const current = locate(move.resourceId)
		if (!current) {
			throw new ListMembershipError(
				`Resource ${move.resourceId} is not in this list`,
				404,
				'RESOURCE_NOT_IN_LIST',
			)
		}

		const toParentId = move.parentId ?? current.parentId

		if (toParentId !== listId) {
			const parentPlacement = byParent
				.get(listId)!
				.find((row) => row.resourceId === toParentId)
			if (!parentPlacement) {
				throw new ListMembershipError(
					`Parent ${toParentId} is not a section of this list`,
					404,
					'PARENT_NOT_IN_LIST',
				)
			}
			if (typeOf.get(toParentId) !== 'section') {
				throw new ListMembershipError(
					`Parent ${toParentId} is not a section`,
					400,
					'PARENT_NOT_A_SECTION',
				)
			}
			// The tree is two levels: a section holds leaves, never another
			// section — which also makes a self-parent inexpressible.
			if (typeOf.get(move.resourceId) === 'section') {
				throw new ListMembershipError(
					'A section cannot nest inside a section',
					400,
					'SECTION_NESTING',
				)
			}
			if (
				toParentId !== current.parentId &&
				byParent
					.get(toParentId)!
					.some((row) => row.resourceId === move.resourceId)
			) {
				throw new ListMembershipError(
					`Parent ${toParentId} already holds ${move.resourceId}`,
					409,
					'RESOURCE_ALREADY_IN_LIST',
				)
			}
		}

		const [row] = byParent.get(current.parentId)!.splice(current.index, 1)
		const target = byParent.get(toParentId)!
		target.splice(Math.max(0, Math.min(move.position, target.length)), 0, row!)
	}

	// Dense renumbering from the final arrangement. A row is written when its
	// parent or its position changed — including siblings the batch never
	// named, and rows whose stored positions had gone sparse.
	const writes: PlannedWrite[] = []
	for (const [parentId, siblings] of byParent) {
		siblings.forEach((row, index) => {
			if (row.fromParentId !== parentId || row.fromPosition !== index) {
				writes.push({
					resourceId: row.resourceId,
					fromParentId: row.fromParentId,
					toParentId: parentId,
					position: index,
				})
			}
		})
	}
	return writes
}

/** The list plus two levels — enough to see sections and what they hold. */
async function loadListTree(
	listIdOrSlug: string,
	executor: Pick<typeof db, 'query'> = db,
) {
	return executor.query.contentResource.findFirst({
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
 * List membership rows are content relations, so beside broad `update
 * Content` (device tokens) this accepts the `content:relations` PAT scope —
 * the same gate the tag attach/detach routes use. 403, not 401: the route has
 * already established there IS a credential, so a refusal here means a valid
 * token without the ability, and an agent shouldn't retry.
 */
function assertCanUpdate(ability: AppAbility) {
	if (!canUpdateContentRelation(ability)) {
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
	const input = parseOrThrow(AddListItemInputSchema, data)
	const list = await requireList(listIdOrSlug)

	const resource = await db.query.contentResource.findFirst({
		where: eq(contentResource.id, input.resourceId),
	})
	if (!resource) {
		throw new ListMembershipError('Resource not found', 404, 'RESOURCE_NOT_FOUND')
	}

	const rows = list.resources as MembershipRow[]
	const parentId = input.parentId ?? list.id

	if (parentId !== list.id) {
		const parentRow = rows.find((row) => row.resourceId === parentId)
		if (!parentRow) {
			throw new ListMembershipError(
				'Parent section is not in this list',
				404,
				'PARENT_NOT_IN_LIST',
			)
		}
		// Two levels, strictly: only sections parent, and never each other.
		if (parentRow.resource?.type !== 'section') {
			throw new ListMembershipError(
				`Parent ${parentId} is not a section`,
				400,
				'PARENT_NOT_A_SECTION',
			)
		}
		if (resource.type === 'section') {
			throw new ListMembershipError(
				'A section cannot nest inside a section',
				400,
				'SECTION_NESTING',
			)
		}
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

/**
 * Take a resource out of a list. When it sits in more than one place,
 * `parentId` names the placement; omitted, the top-level placement wins (the
 * same preference the editor shows).
 */
export async function removeItemFromList({
	listIdOrSlug,
	resourceId,
	parentId,
	ability,
}: {
	listIdOrSlug: string
	resourceId: string
	parentId?: string
	ability: AppAbility
}) {
	assertCanUpdate(ability)
	const list = await requireList(listIdOrSlug)
	const rows = list.resources as MembershipRow[]

	let location: ItemLocation | null
	if (parentId) {
		const row = siblingsOf(list.id, rows, parentId).find(
			(sibling) => sibling.resourceId === resourceId,
		)
		location = row ? { parentId, position: row.position } : null
	} else {
		location = locateItem(list.id, rows, resourceId)
	}
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
 * Reorder items and move them between sections in one transaction. The tree is
 * read inside the same transaction the writes run in, so the plan cannot go
 * stale against a concurrent edit, and the applied writes come back — sibling
 * renumbering included — so the caller sees exactly what changed.
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
	const input = parseOrThrow(MoveListItemsInputSchema, data)

	const applied = await db.transaction(async (trx) => {
		const list = await loadListTree(listIdOrSlug, trx)
		if (!list) {
			throw new ListMembershipError('List not found', 404, 'LIST_NOT_FOUND')
		}
		const writes = planMoves(
			list.id,
			list.resources as MembershipRow[],
			input.items,
		)
		for (const write of writes) {
			await trx
				.update(contentResourceResource)
				.set({ resourceOfId: write.toParentId, position: write.position })
				.where(
					and(
						eq(contentResourceResource.resourceOfId, write.fromParentId),
						eq(contentResourceResource.resourceId, write.resourceId),
					),
				)
		}
		return { listId: list.id, writes }
	})

	revalidateList(applied.listId)

	return applied.writes
}
