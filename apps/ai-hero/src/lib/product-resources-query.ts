'use server'

import { db } from '@/db'
import { contentResourceProduct } from '@/db/schema'
import { getServerAuthSession } from '@/server/auth'
import { and, asc, eq, isNull } from 'drizzle-orm'

import type { ContentsItem } from '@coursebuilder/ui/cms/manifest'

/**
 * Product ⇄ content attachment for the cms product editor's Resources surface.
 *
 * Products attach content via the `ContentResourceProduct` join table (keys
 * `productId`/`resourceId` — NOT `contentResourceResource`), so none of the
 * list/tree helpers apply. The legacy product form only ever had `add`
 * (`addResourceToProduct`); its tree's remove/reorder silently targeted the
 * wrong table and never persisted. These are the first real product-scoped
 * remove/reorder actions.
 *
 * Removal is a SOFT delete (`deletedAt`, the `resources-query` convention —
 * `getResourceParents` already filters product joins by `isNull(deletedAt)`).
 * CAVEAT: the adapter's `getProduct` does NOT filter `deletedAt` on its
 * `resources` relation, so soft-removed rows still surface anywhere that
 * reads `product.resources` directly. The join's PK is (productId,
 * resourceId), so re-attaching a soft-deleted resource RESTORES the row
 * instead of inserting.
 */

async function assertCanEditProducts() {
	const { session, ability } = await getServerAuthSession()
	if (!session?.user || !ability.can('create', 'Content')) {
		throw new Error('Unauthorized')
	}
	return session.user
}

/** Active (non-deleted) join rows for a product, position-ordered. */
export async function listProductResources(
	productId: string,
): Promise<ContentsItem[]> {
	await assertCanEditProducts()

	const rows = await db.query.contentResourceProduct.findMany({
		where: and(
			eq(contentResourceProduct.productId, productId),
			isNull(contentResourceProduct.deletedAt),
		),
		with: { resource: true },
		orderBy: asc(contentResourceProduct.position),
	})

	return rows
		.filter((row) => row.resource && !row.resource.deletedAt)
		.map((row, index) => ({
			id: row.resourceId,
			type: row.resource.type,
			title:
				row.resource.fields?.title ??
				row.resource.fields?.slug ??
				row.resourceId,
			slug: row.resource.fields?.slug ?? undefined,
			state: row.resource.fields?.state ?? undefined,
			visibility: row.resource.fields?.visibility ?? undefined,
			detail: row.resource.type,
			// Re-index densely: legacy positions can collide (double column,
			// add-at-`resources.length` counted soft-deleted rows).
			position: index,
		}))
}

/**
 * Attach a resource to a product at the end of the list. Restores the join
 * row when a soft-deleted one exists (the PK forbids a second insert).
 */
export async function addResourceToProductById(input: {
	productId: string
	resourceId: string
}): Promise<{ position: number }> {
	const user = await assertCanEditProducts()
	const { productId, resourceId } = input

	const siblings = await db.query.contentResourceProduct.findMany({
		where: and(
			eq(contentResourceProduct.productId, productId),
			isNull(contentResourceProduct.deletedAt),
		),
	})
	const position = siblings.length

	const existing = await db.query.contentResourceProduct.findFirst({
		where: and(
			eq(contentResourceProduct.productId, productId),
			eq(contentResourceProduct.resourceId, resourceId),
		),
	})

	if (existing) {
		if (!existing.deletedAt) return { position: existing.position }
		await db
			.update(contentResourceProduct)
			.set({ deletedAt: null, position })
			.where(
				and(
					eq(contentResourceProduct.productId, productId),
					eq(contentResourceProduct.resourceId, resourceId),
				),
			)
		return { position }
	}

	await db.insert(contentResourceProduct).values({
		productId,
		resourceId,
		position,
		metadata: { addedBy: user.id },
	})

	return { position }
}

/** Soft-detach a resource from a product (`deletedAt`, join row kept). */
export async function removeResourceFromProduct(input: {
	productId: string
	resourceId: string
}): Promise<void> {
	await assertCanEditProducts()

	await db
		.update(contentResourceProduct)
		.set({ deletedAt: new Date() })
		.where(
			and(
				eq(contentResourceProduct.productId, input.productId),
				eq(contentResourceProduct.resourceId, input.resourceId),
			),
		)
}

/**
 * Persist a full-list position rewrite in one transaction (flat — product
 * attachments have no sections). Metadata is left untouched so `addedBy`
 * survives reorders.
 */
export async function reorderProductResources(input: {
	productId: string
	updates: { resourceId: string; position: number }[]
}): Promise<void> {
	await assertCanEditProducts()

	await db.transaction(async (trx) => {
		for (const update of input.updates) {
			await trx
				.update(contentResourceProduct)
				.set({ position: update.position })
				.where(
					and(
						eq(contentResourceProduct.productId, input.productId),
						eq(contentResourceProduct.resourceId, update.resourceId),
					),
				)
		}
	})
}
