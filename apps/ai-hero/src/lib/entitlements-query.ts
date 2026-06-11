import { db } from '@/db'
import { entitlements, organizationMemberships } from '@/db/schema'
import {
	PRODUCT_TYPE_CONFIG,
	type ProductType,
} from '@/inngest/config/product-types'
import { EntitlementSourceType } from '@/lib/entitlements'
import { log } from '@/server/logger'
import { and, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm'

/**
 * Get all active entitlements for a user across all their organizations
 * Excludes soft-deleted entitlements
 */
export async function getAllUserEntitlements(userId: string) {
	// Get all organization memberships for the user
	const allMemberships = await db.query.organizationMemberships.findMany({
		where: eq(organizationMemberships.userId, userId),
	})

	const allMembershipIds = allMemberships.map((m) => m.id)

	// Load entitlements from ALL user organizations
	const activeEntitlements =
		allMembershipIds.length > 0
			? await db.query.entitlements.findMany({
					where: and(
						inArray(entitlements.organizationMembershipId, allMembershipIds),
						or(
							isNull(entitlements.expiresAt),
							gt(entitlements.expiresAt, sql`CURRENT_TIMESTAMP`),
						),
						isNull(entitlements.deletedAt),
					),
				})
			: []

	return activeEntitlements
}

/**
 * Check if user already has an active entitlement for a specific resource
 */
async function hasExistingEntitlement(
	userId: string,
	resourceId: string,
	entitlementTypeId: string,
): Promise<boolean> {
	const existingEntitlement = await db.query.entitlements.findFirst({
		where: and(
			eq(entitlements.userId, userId),
			eq(entitlements.entitlementType, entitlementTypeId),
			isNull(entitlements.deletedAt),
			sql`JSON_CONTAINS(${entitlements.metadata}, ${JSON.stringify(resourceId)}, '$.contentIds')`,
		),
	})

	return !!existingEntitlement
}

/**
 * Create resource entitlements based on product type
 * Shared logic used by post-purchase and transfer workflows
 * Prevents duplicate entitlements for the same user/resource/entitlementType combination
 */
export async function createResourceEntitlements(
	productType: ProductType,
	resource: any,
	params: {
		user: any
		purchase: any
		organizationId: string
		orgMembership: any
		contentAccessEntitlementType: any
		expiresAt?: Date
		metadata?: Record<string, any>
	},
) {
	const {
		user,
		purchase,
		organizationId,
		orgMembership,
		contentAccessEntitlementType,
		expiresAt,
		metadata = {},
	} = params
	const config = PRODUCT_TYPE_CONFIG[productType]
	const createdEntitlements: Array<{
		entitlementId: string
		resourceId: string
		resourceType: string
		resourceTitle?: string
	}> = []

	if (productType === 'cohort') {
		// Loop through cohort workshop resources only. Cohorts can also have
		// attached reminder emails, and those should not become content entitlements.
		for (const resourceItem of resource.resources || []) {
			// Skip items where resource is null
			if (!resourceItem.resource) {
				await log.warn('entitlement.resource_item_skipped', {
					userId: user.id,
					purchaseId: purchase.id,
					reason: 'Resource item has null resource',
				})
				continue
			}

			if (resourceItem.resource.type !== 'workshop') {
				await log.info('entitlement.non_workshop_resource_skipped', {
					userId: user.id,
					purchaseId: purchase.id,
					resourceId: resourceItem.resource.id,
					resourceType: resourceItem.resource.type,
					reason:
						'Cohort content access should only be granted for workshop resources',
				})
				continue
			}

			const resourceId = resourceItem.resource.id

			// Check for existing entitlement before creating
			const alreadyHasEntitlement = await hasExistingEntitlement(
				user.id,
				resourceId,
				contentAccessEntitlementType.id,
			)

			if (alreadyHasEntitlement) {
				await log.info('entitlement.duplicate_skipped', {
					userId: user.id,
					resourceId,
					resourceType: resourceItem.resource.type,
					entitlementType: contentAccessEntitlementType.id,
					purchaseId: purchase.id,
					reason: 'User already has active entitlement for this resource',
				})
				continue
			}

			const entitlementId = await config.createEntitlement({
				userId: user.id,
				resourceId,
				sourceId: purchase.id,
				organizationId,
				organizationMembershipId: orgMembership.id,
				entitlementType: contentAccessEntitlementType.id,
				sourceType: EntitlementSourceType.PURCHASE,
				expiresAt,
				metadata: {
					...metadata,
					contentIds: [resourceId],
				},
			})

			createdEntitlements.push({
				entitlementId,
				resourceId,
				resourceType: resourceItem.resource.type,
				resourceTitle: resourceItem.resource.fields?.title,
			})
		}
	} else {
		// Single workshop resource
		const resourceId = resource.id

		// Check for existing entitlement before creating
		const alreadyHasEntitlement = await hasExistingEntitlement(
			user.id,
			resourceId,
			contentAccessEntitlementType.id,
		)

		if (alreadyHasEntitlement) {
			await log.info('entitlement.duplicate_skipped', {
				userId: user.id,
				resourceId,
				resourceType: resource.type,
				entitlementType: contentAccessEntitlementType.id,
				purchaseId: purchase.id,
				reason: 'User already has active entitlement for this resource',
			})
		} else {
			const entitlementId = await config.createEntitlement({
				userId: user.id,
				resourceId,
				sourceId: purchase.id,
				organizationId,
				organizationMembershipId: orgMembership.id,
				entitlementType: contentAccessEntitlementType.id,
				sourceType: EntitlementSourceType.PURCHASE,
				expiresAt,
				metadata: {
					...metadata,
					contentIds: [resourceId],
				},
			})

			createdEntitlements.push({
				entitlementId,
				resourceId,
				resourceType: resource.type,
				resourceTitle: resource.fields?.title,
			})
		}
	}

	return createdEntitlements
}
