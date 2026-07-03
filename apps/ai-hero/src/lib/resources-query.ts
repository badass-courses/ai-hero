'use server'

import { revalidatePath, revalidateTag } from 'next/cache'
import { courseBuilderAdapter, db } from '@/db'
import {
	contentResource,
	contentResourceProduct,
	contentResourceResource,
} from '@/db/schema'
import { getServerAuthSession } from '@/server/auth'
import { log } from '@/server/logger'
import {
	and,
	asc,
	desc,
	eq,
	inArray,
	isNull,
	notInArray,
	sql,
} from 'drizzle-orm'

import { getResourcePath } from '@coursebuilder/utils/resource-paths'

import { triggerCohortEntitlementSync } from './cohort-update-trigger'
import {
	ListResourcesForPickerInputSchema,
	ListVideoResourcesForPickerInputSchema,
	type ListResourcesForPickerInput,
	type ListVideoResourcesForPickerInput,
	type PickerItem,
	type ResourceParent,
	type VideoPickerItem,
} from './resources'
import { upsertPostToTypeSense } from './typesense-query'

export async function updateResource(input: {
	id: string
	type: string
	fields: Record<string, any>
	createdById: string
}) {
	const { session, ability } = await getServerAuthSession()
	const user = session?.user

	if (!user || !ability.can('update', 'Content')) {
		await log.error('resource.update.unauthorized', {
			resourceId: input.id,
			userId: user?.id,
		})
		throw new Error('Unauthorized')
	}

	const currentResource = await courseBuilderAdapter.getContentResource(
		input.id,
	)

	if (!currentResource) {
		await log.info('resource.create.started', {
			resourceId: input.id,
			type: input.type,
			userId: user.id,
		})

		const newResource = await courseBuilderAdapter.createContentResource(input)

		if (newResource) {
			try {
				await upsertPostToTypeSense(newResource, 'save')
				await log.info('resource.typesense.indexed', {
					resourceId: newResource.id,
					action: 'save',
				})
			} catch (error) {
				await log.error('resource.typesense.index.failed', {
					error: getErrorMessage(error),
					resourceId: newResource.id,
				})
			}

			const newSlug = newResource.fields?.slug
			if (newSlug) {
				revalidatePath(getResourcePath(input.type, newSlug))
			}
			revalidateTag(input.type, 'max')
		}

		return newResource
	}

	// Slugs are intentionally NOT regenerated when the title changes — only an
	// explicit edit to the slug field changes the slug.
	const resourceSlug = input.fields.slug ?? currentResource?.fields?.slug

	const updatedResource =
		await courseBuilderAdapter.updateContentResourceFields({
			id: currentResource.id,
			fields: {
				...currentResource.fields,
				...input.fields,
				slug: resourceSlug,
				...(input.fields.image && {
					image: input.fields.image,
				}),
			},
		})

	if (updatedResource) {
		try {
			await upsertPostToTypeSense(updatedResource, 'save')
			await log.info('resource.update.typesense.success', {
				resourceId: input.id,
				action: 'save',
				userId: user.id,
			})
		} catch (error) {
			await log.error('resource.update.typesense.failed', {
				resourceId: input.id,
				error: getErrorMessage(error),
				userId: user.id,
			})
		}
	}

	await log.info('resource.update.success', {
		resourceId: input.id,
		userId: user.id,
		changes: Object.keys(input.fields),
	})

	const slugForPath = updatedResource?.fields?.slug ?? resourceSlug
	if (slugForPath) {
		revalidatePath(getResourcePath(input.type, slugForPath))
	}
	revalidateTag(input.type, 'max')

	// Trigger entitlement sync for cohorts
	if (input.type === 'cohort') {
		try {
			await triggerCohortEntitlementSync(input.id, {})
		} catch (error) {
			await log.error('cohort.entitlement_sync.trigger_failed', {
				cohortId: input.id,
				error: error instanceof Error ? error.message : String(error),
			})
		}
	}

	return updatedResource
}

/**
 * One-level reverse lookup: every resource this resource is directly part of.
 *
 * Covers both membership mechanisms:
 * - `ContentResourceResource` (child → parent via `resourceOf`): post ∈ list,
 *   lesson ∈ workshop/section, workshop ∈ cohort
 * - `ContentResourceProduct`: cohort/workshop ∈ product
 *
 * Powers the "Part of" strip in the resource editor; `href` is the parent's
 * EDIT path (click-through per doc-11). `detail` carries cheap context —
 * ordinal position ('#3 of 12') for hierarchy parents.
 */
export async function getResourceParents(
	resourceId: string,
): Promise<ResourceParent[]> {
	const { session, ability } = await getServerAuthSession()
	if (!session?.user || !ability.can('update', 'Content')) {
		throw new Error('Unauthorized')
	}

	const [containerLinks, productLinks] = await Promise.all([
		db.query.contentResourceResource.findMany({
			where: eq(contentResourceResource.resourceId, resourceId),
			with: {
				resourceOf: {
					with: {
						// Sibling JOIN rows only (no nested resource objects) —
						// cheap, and enough to compute this resource's ordinal.
						resources: {
							orderBy: asc(contentResourceResource.position),
						},
					},
				},
			},
		}),
		db.query.contentResourceProduct.findMany({
			where: and(
				eq(contentResourceProduct.resourceId, resourceId),
				isNull(contentResourceProduct.deletedAt),
			),
			with: {
				product: true,
			},
		}),
	])

	const parents: ResourceParent[] = []

	for (const link of containerLinks) {
		const parent = link.resourceOf
		if (!parent || parent.deletedAt) continue
		const slug: string = parent.fields?.slug ?? ''
		const siblings = parent.resources ?? []
		const index = siblings.findIndex(
			(sibling) => sibling.resourceId === resourceId,
		)
		parents.push({
			id: parent.id,
			type: parent.type,
			title: parent.fields?.title ?? (slug || parent.id),
			slug,
			href: getResourcePath(parent.type, slug || parent.id, 'edit'),
			...(index !== -1 && {
				detail: `#${index + 1} of ${siblings.length}`,
			}),
		})
	}

	for (const link of productLinks) {
		const product = link.product
		if (!product) continue
		const slug: string = product.fields?.slug ?? ''
		parents.push({
			id: product.id,
			type: 'product',
			title: product.name,
			slug,
			// Products aren't in the shared resource-paths registry; the app's
			// product editor lives at /products/[slug]/edit.
			href: `/products/${slug || product.id}/edit`,
		})
	}

	return parents
}

/**
 * Recent-first, DB-backed resource query for the editor's ResourcePicker.
 *
 * Replaces the empty-TypeSense-combobox pattern: `ORDER BY updatedAt DESC`
 * so the resources you just touched surface first; optional title substring
 * search as a secondary path (TypeSense remains the primary search surface
 * and is untouched). Lean select — no bodies shipped to the client.
 */
export async function listResourcesForPicker(
	input: ListResourcesForPickerInput,
): Promise<PickerItem[]> {
	const { session, ability } = await getServerAuthSession()
	if (!session?.user || !ability.can('create', 'Content')) {
		throw new Error('Unauthorized')
	}

	const { types, search, excludeIds, limit } =
		ListResourcesForPickerInputSchema.parse(input)

	const conditions = [
		inArray(contentResource.type, types),
		isNull(contentResource.deletedAt),
	]
	if (excludeIds.length > 0) {
		conditions.push(notInArray(contentResource.id, excludeIds))
	}
	if (search) {
		// MySQL LIKE is case-insensitive under the default collation;
		// escape LIKE metacharacters so user input matches literally.
		const escaped = search.replace(/[\\%_]/g, '\\$&')
		conditions.push(
			sql`JSON_UNQUOTE(JSON_EXTRACT(${contentResource.fields}, '$.title')) LIKE ${`%${escaped}%`}`,
		)
	}

	const rows = await db
		.select({
			id: contentResource.id,
			type: contentResource.type,
			title: sql<
				string | null
			>`JSON_UNQUOTE(JSON_EXTRACT(${contentResource.fields}, '$.title'))`,
			slug: contentResource.slug,
			state: sql<
				string | null
			>`JSON_UNQUOTE(JSON_EXTRACT(${contentResource.fields}, '$.state'))`,
			updatedAt: contentResource.updatedAt,
		})
		.from(contentResource)
		.where(and(...conditions))
		.orderBy(desc(contentResource.updatedAt))
		.limit(limit)

	return rows.map((row) => ({
		id: row.id,
		type: row.type,
		title: row.title ?? row.slug ?? row.id,
		slug: row.slug ?? '',
		state: row.state ?? 'draft',
		updatedAt: row.updatedAt,
	}))
}

/**
 * Recent-first video library for the post editor's "Choose existing" picker.
 *
 * A sibling of `listResourcesForPicker` because videoResources don't fit its
 * shape: they have no `fields.title`/slug (the id IS the upload filename, so
 * search matches the id), their `fields.state` is a video lifecycle
 * ('processing'/'ready'/…) rather than editorial, and picker rows want the
 * Mux poster + duration. Same auth gate; newest-first by `createdAt` (the
 * legacy videos tool's ordering — uploads don't get edited, they get created).
 */
export async function listVideoResourcesForPicker(
	input: ListVideoResourcesForPickerInput = {},
): Promise<VideoPickerItem[]> {
	const { session, ability } = await getServerAuthSession()
	if (!session?.user || !ability.can('create', 'Content')) {
		throw new Error('Unauthorized')
	}

	const { search, excludeIds, limit } =
		ListVideoResourcesForPickerInputSchema.parse(input)

	// JSON-free conditions ONLY: even an id-only sorted query hits Vitess's
	// "Out of sort memory" (errno 1038) when the WHERE computes JSON_EXTRACT
	// over a large library — the lifecycle-state filter moves to app code
	// below (with over-fetch so the page still fills).
	const conditions = [
		eq(contentResource.type, 'videoResource'),
		isNull(contentResource.deletedAt),
	]
	if (excludeIds.length > 0) {
		conditions.push(notInArray(contentResource.id, excludeIds))
	}
	if (search) {
		// Escape LIKE metacharacters so user input matches literally.
		const escaped = search.replace(/[\\%_]/g, '\\$&')
		conditions.push(sql`${contentResource.id} LIKE ${`%${escaped}%`}`)
	}

	// Two-step on purpose: ORDER BY over rows that also compute JSON_EXTRACTs
	// blows MySQL's sort buffer on large libraries ("Out of sort memory",
	// errno 1038 on PlanetScale) — so sort/limit a minimal id+createdAt page
	// first, then pull the JSON fields for just that page.
	const pageRows = await db
		.select({ id: contentResource.id, createdAt: contentResource.createdAt })
		.from(contentResource)
		.where(and(...conditions))
		.orderBy(desc(contentResource.createdAt))
		// Over-fetch: the state filter below may drop rows.
		.limit(limit + 50)
	if (pageRows.length === 0) return []

	const detailRows = await db
		.select({
			id: contentResource.id,
			state: sql<
				string | null
			>`JSON_UNQUOTE(JSON_EXTRACT(${contentResource.fields}, '$.state'))`,
			muxPlaybackId: sql<
				string | null
			>`JSON_UNQUOTE(JSON_EXTRACT(${contentResource.fields}, '$.muxPlaybackId'))`,
			duration: sql<
				number | string | null
			>`JSON_EXTRACT(${contentResource.fields}, '$.duration')`,
			createdAt: contentResource.createdAt,
		})
		.from(contentResource)
		.where(
			inArray(
				contentResource.id,
				pageRows.map((row) => row.id),
			),
		)
	// Re-impose the page order — the IN() fetch returns rows unordered.
	const byId = new Map(detailRows.map((row) => [row.id, row]))
	const rows = pageRows
		.flatMap((page) => byId.get(page.id) ?? [])
		// Hide unusable videos; keep processing ones (attach works mid-process).
		.filter((row) => row.state !== 'deleted' && row.state !== 'errored')
		.slice(0, limit)

	return rows.map((row) => ({
		id: row.id,
		// videoResources have no title/slug — the filename-derived id is the
		// human-readable handle (matches the legacy videos tool).
		title: row.id,
		state: row.state ?? 'processing',
		thumbnailUrl: row.muxPlaybackId
			? `https://image.mux.com/${row.muxPlaybackId}/thumbnail.png?width=96&height=54&fit_mode=smartcrop`
			: undefined,
		duration: row.duration != null ? Number(row.duration) : null,
		createdAt: row.createdAt,
	}))
}

function getErrorMessage(error: unknown): string {
	if (error instanceof Error) return error.message
	return String(error)
}
