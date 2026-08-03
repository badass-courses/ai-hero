'use server'

import { db } from '@/db'
import {
	contentResource,
	contentResourceProduct,
	contentResourceResource,
} from '@/db/schema'
import { log } from '@/server/logger'
import { measureIfSlow } from '@/server/perf'
import { and, asc, eq, inArray, isNull, or, sql } from 'drizzle-orm'

import { productSchema } from '@coursebuilder/core/schemas'

import {
	ResourceNavigationSchema,
	type Level1ResourceWrapper,
	type Level2ResourceWrapper,
	type ResourceNavigation,
} from './content-navigation'
import {
	buildNavigationTree,
	cleanNavigationFields,
	groupNavigationRows,
} from './content-navigation-tree'

/**
 * Fields that should be preserved in navigation (excludes heavy content like body)
 */
const NAVIGATION_FIELDS = ['slug', 'title', 'visibility', 'state'] as const

/**
 * Strips heavy fields from a resource's fields object, keeping only navigation-required fields
 */
function stripHeavyFields(
	fields: Record<string, any> | null | undefined,
): Record<string, any> | null | undefined {
	if (!fields) return fields

	const stripped: Record<string, any> = {}
	for (const key of NAVIGATION_FIELDS) {
		if (key in fields && fields[key] !== undefined) {
			stripped[key] = fields[key]
		}
	}

	return Object.keys(stripped).length > 0 ? stripped : null
}

/**
 * Recursively strips heavy fields from nested resources
 */
function stripHeavyFieldsFromResource(resource: any): any {
	if (!resource) return resource

	const strippedFields = stripHeavyFields(resource.fields)

	const result = {
		...resource,
		fields: strippedFields,
	}

	if (resource.resources) {
		result.resources = resource.resources.map((wrapper: any) => ({
			...wrapper,
			resource: stripHeavyFieldsFromResource(wrapper.resource),
		}))
	}

	return result
}

/**
 * The nav projection of a resource's `fields`, computed IN the select: only
 * these keys ever leave the database. The old shape of this loader fetched
 * every `fields` blob in the tree — every lesson body — and stripped them in
 * JS afterwards, which is why it held the workshop sidebar's query at p50
 * 213 ms / p99 1.19 s on the database (Insights, 2026-08-03).
 */
const navigationFieldsProjection = sql<
	string | Record<string, any>
>`JSON_OBJECT(
	'slug', JSON_EXTRACT(${contentResource.fields}, '$.slug'),
	'title', JSON_EXTRACT(${contentResource.fields}, '$.title'),
	'visibility', JSON_EXTRACT(${contentResource.fields}, '$.visibility'),
	'state', JSON_EXTRACT(${contentResource.fields}, '$.state')
)`

/**
 * Columns of a nav tree node: every `AI_ContentResource` column EXCEPT the
 * raw `fields` blob, which the projection above replaces. The full set
 * matters — `ContentResourceSchema` requires keys like `organizationId` and
 * `createdByOrganizationMembershipId` even when null, and a first cut of this
 * select without them failed the parse and blanked the cohort sidebar.
 */
const navigationResourceColumns = {
	id: contentResource.id,
	organizationId: contentResource.organizationId,
	createdByOrganizationMembershipId:
		contentResource.createdByOrganizationMembershipId,
	type: contentResource.type,
	createdById: contentResource.createdById,
	slug: contentResource.slug,
	currentVersionId: contentResource.currentVersionId,
	createdAt: contentResource.createdAt,
	updatedAt: contentResource.updatedAt,
	deletedAt: contentResource.deletedAt,
	fields: navigationFieldsProjection,
}

/** One level of the tree: join rows + their resources, nav columns only. */
async function selectNavigationChildren(parentIds: string[]) {
	if (parentIds.length === 0) return []
	return db
		.select({
			resourceId: contentResourceResource.resourceId,
			resourceOfId: contentResourceResource.resourceOfId,
			position: contentResourceResource.position,
			metadata: contentResourceResource.metadata,
			createdAt: contentResourceResource.createdAt,
			updatedAt: contentResourceResource.updatedAt,
			deletedAt: contentResourceResource.deletedAt,
			resource: navigationResourceColumns,
		})
		.from(contentResourceResource)
		.innerJoin(
			contentResource,
			eq(contentResource.id, contentResourceResource.resourceId),
		)
		.where(
			and(
				inArray(contentResourceResource.resourceOfId, parentIds),
				// No soft-deleted link rows or resources in nav. Currently moot
				// (production has zero soft-deleted rows) but it is the standing
				// convention of the other resource queries.
				isNull(contentResourceResource.deletedAt),
				isNull(contentResource.deletedAt),
			),
		)
		.orderBy(
			asc(contentResourceResource.resourceOfId),
			asc(contentResourceResource.position),
		)
}

/**
 * Fetches content navigation
 * Returns ContentResource with nested resources and optional parents (products)
 *
 * Loads the tree as one flat, indexed query PER LEVEL (root, then children,
 * grandchildren, great-grandchildren — three levels below the root, so a
 * lesson's solutions are included) and nests them in JS. The previous single
 * relational query expressed the same tree as correlated `json_arrayagg`
 * subqueries that MySQL executed per row while dragging every body along —
 * see `navigationFieldsProjection`.
 */
export async function getContentNavigation(slugOrId: string) {
	return measureIfSlow({
		event: 'perf.content-navigation.fetch.slow',
		spanName: 'content-navigation.fetch',
		thresholdMs: 120,
		data: { slugOrId },
		operation: async () => {
			const rootRows = await db
				.select(navigationResourceColumns)
				.from(contentResource)
				.where(
					and(
						or(
							eq(
								sql`JSON_EXTRACT(${contentResource.fields}, "$.slug")`,
								slugOrId,
							),
							eq(contentResource.id, slugOrId),
						),
						isNull(contentResource.deletedAt),
					),
				)
				.limit(1)
			const root = rootRows[0]

			if (!root) {
				return null
			}

			const levelOne = await selectNavigationChildren([root.id])
			const levelTwo = await selectNavigationChildren(
				levelOne.map((row) => row.resourceId),
			)
			const levelThree = await selectNavigationChildren(
				levelTwo.map((row) => row.resourceId),
			)

			const byParent = groupNavigationRows([
				...levelOne,
				...levelTwo,
				...levelThree,
			])

			const resource = {
				...root,
				fields: cleanNavigationFields(root.fields),
				resources: buildNavigationTree(byParent, root.id, 3),
			}

			const directProductRelations =
				await db.query.contentResourceProduct.findMany({
					where: eq(contentResourceProduct.resourceId, resource.id),
					with: {
						product: {
							with: {
								resources: {
									with: {
										resource: true,
									},
									orderBy: asc(contentResourceProduct.position),
								},
							},
						},
					},
				})

			const parentRelations = await db.query.contentResourceResource.findMany({
				where: eq(contentResourceResource.resourceId, resource.id),
			})

			const parentProductRelations =
				parentRelations.length > 0
					? await db.query.contentResourceProduct.findMany({
							where: or(
								...parentRelations.map((rel) =>
									eq(contentResourceProduct.resourceId, rel.resourceOfId),
								),
							),
							with: {
								product: {
									with: {
										resources: {
											with: {
												resource: true,
											},
											orderBy: asc(contentResourceProduct.position),
										},
									},
								},
							},
						})
					: []

			const productRelations = [
				...directProductRelations,
				...parentProductRelations,
			]

			// The tree is already minimal — its fields were projected in SQL. Only
			// the product payloads still arrive full and need the strip pass.
			const strippedResource = resource
			const strippedProductRelations = productRelations.map((rel) => ({
				...rel,
				product: rel.product
					? {
							...rel.product,
							fields: stripHeavyFields(rel.product.fields),
							resources: rel.product.resources?.map((productRel) => ({
								...productRel,
								resource: productRel.resource
									? stripHeavyFieldsFromResource(productRel.resource)
									: productRel.resource,
							})),
						}
					: rel.product,
			}))

			const validatedResource =
				ResourceNavigationSchema.safeParse(strippedResource)
			if (!validatedResource.success) {
				void log.error('navigation.parse.error', {
					slugOrId,
					resourceId: strippedResource?.id,
					error: validatedResource.error.message,
				})
				return null
			}

			const filteredResource = filterVideoResources(validatedResource.data)
			const products = strippedProductRelations
				.map((rel) => rel.product)
				.filter(
					(p): p is NonNullable<typeof p> => p !== null && p !== undefined,
				)
				.map((product) => productSchema.parse(product))

			return {
				...filteredResource,
				parents: products.length > 0 ? products : undefined,
			}
		},
	})
}

/**
 * Filters out videoResource types from level 2 (deepest nested resources)
 */
function filterLevel2Resources(
	wrappers: Level2ResourceWrapper[] | null | undefined,
): Level2ResourceWrapper[] | null | undefined {
	if (!wrappers) return wrappers
	return wrappers.filter((wrapper) => wrapper.resource.type !== 'videoResource')
}

/**
 * Filters out videoResource types from level 1 resources and their nested resources
 */
function filterLevel1Resources(
	wrappers: Level1ResourceWrapper[] | null | undefined,
): Level1ResourceWrapper[] | null | undefined {
	if (!wrappers) return wrappers

	return wrappers
		.filter((wrapper) => wrapper.resource.type !== 'videoResource')
		.map((wrapper) => ({
			...wrapper,
			resource: {
				...wrapper.resource,
				resources: filterLevel2Resources(wrapper.resource.resources),
			},
		}))
}

/**
 * Filters out videoResource types from the entire navigation tree
 */
function filterVideoResources(data: ResourceNavigation): ResourceNavigation {
	return {
		...data,
		resources: filterLevel1Resources(data.resources),
	}
}
