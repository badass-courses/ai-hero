import { db } from '@/db'
import {
	contentResourceProduct,
	entitlements,
	entitlementTypes,
	organizationMemberships,
	purchases,
	users,
} from '@/db/schema'
import { log } from '@/server/logger'
import { and, eq, isNull, ne, sql } from 'drizzle-orm'

import {
	createCohortEntitlementInTransaction,
	EntitlementSourceType,
} from './entitlements'

/**
 * Find all users who have entitlements for a specific cohort.
 * Uses a single JOIN query instead of N+1 loops for performance.
 */
export async function findUsersWithCohortEntitlements(cohortId: string) {
	const cohortContentAccessEntitlementType =
		await db.query.entitlementTypes.findFirst({
			where: eq(entitlementTypes.name, 'cohort_content_access'),
		})

	if (!cohortContentAccessEntitlementType) {
		throw new Error('cohort_content_access entitlement type not found')
	}

	// Single JOIN query: entitlements -> purchases -> contentResourceProduct
	// This replaces the N+1 loop that was causing timeouts
	// Exclude refunded purchases (Valid and Restricted are both valid for entitlements)
	const results = await db
		.selectDistinct({
			userId: users.id,
			userName: users.name,
			userEmail: users.email,
		})
		.from(entitlements)
		.innerJoin(users, eq(users.id, entitlements.userId))
		.innerJoin(purchases, eq(purchases.id, entitlements.sourceId))
		.innerJoin(
			contentResourceProduct,
			eq(contentResourceProduct.productId, purchases.productId),
		)
		.where(
			and(
				eq(entitlements.sourceType, EntitlementSourceType.PURCHASE),
				eq(entitlements.entitlementType, cohortContentAccessEntitlementType.id),
				isNull(entitlements.deletedAt),
				eq(contentResourceProduct.resourceId, cohortId),
				ne(purchases.status, 'Refunded'),
			),
		)

	return results.map((row) => ({
		user: {
			id: row.userId,
			name: row.userName,
			email: row.userEmail,
		},
	}))
}

/**
 * Get all entitlements for a specific user and cohort.
 * Uses a single JOIN query instead of N+1 loops for performance.
 */
export async function getCurrentCohortEntitlements(
	userId: string,
	cohortId: string,
) {
	const cohortContentAccessEntitlementType =
		await db.query.entitlementTypes.findFirst({
			where: eq(entitlementTypes.name, 'cohort_content_access'),
		})

	if (!cohortContentAccessEntitlementType) {
		return []
	}

	// Single JOIN query: entitlements -> purchases -> contentResourceProduct
	// Filters for specific user and cohort in one query
	const results = await db
		.select({
			id: entitlements.id,
			userId: entitlements.userId,
			sourceId: entitlements.sourceId,
			sourceType: entitlements.sourceType,
			entitlementType: entitlements.entitlementType,
			metadata: entitlements.metadata,
			expiresAt: entitlements.expiresAt,
			createdAt: entitlements.createdAt,
			deletedAt: entitlements.deletedAt,
		})
		.from(entitlements)
		.innerJoin(purchases, eq(purchases.id, entitlements.sourceId))
		.innerJoin(
			contentResourceProduct,
			eq(contentResourceProduct.productId, purchases.productId),
		)
		.where(
			and(
				eq(entitlements.userId, userId),
				eq(entitlements.sourceType, EntitlementSourceType.PURCHASE),
				eq(entitlements.entitlementType, cohortContentAccessEntitlementType.id),
				isNull(entitlements.deletedAt),
				eq(contentResourceProduct.resourceId, cohortId),
			),
		)

	return results
}

/**
 * Calculate what entitlements need to be added/removed based on current state and target resource IDs.
 */
export function calculateEntitlementChangesFromIds(
	currentEntitlements: Array<{ metadata: { contentIds?: string[] } | null }>,
	targetResourceIds: string[],
) {
	// Extract all current content IDs from all entitlements
	const currentResourceIds = new Set<string>()
	currentEntitlements.forEach((entitlement) => {
		const contentIds = entitlement.metadata?.contentIds || []
		contentIds.forEach((id: string) => {
			if (id) currentResourceIds.add(id)
		})
	})

	const updatedResourceIds = new Set<string>(
		targetResourceIds.filter((id): id is string => Boolean(id)),
	)

	const toAdd: string[] = []
	const toRemove: string[] = []

	updatedResourceIds.forEach((resourceId: string) => {
		if (!currentResourceIds.has(resourceId)) {
			toAdd.push(resourceId)
		}
	})

	currentResourceIds.forEach((resourceId: string) => {
		if (!updatedResourceIds.has(resourceId)) {
			toRemove.push(resourceId)
		}
	})

	return { toAdd, toRemove }
}

/**
 * Apply calculated entitlement changes for a user.
 * This is the core logic extracted for reuse.
 */
async function applyEntitlementChanges(
	userId: string,
	cohortId: string,
	changes: { toAdd: string[]; toRemove: string[] },
	startTime: number,
) {
	// If no changes, return early
	if (changes.toAdd.length === 0 && changes.toRemove.length === 0) {
		await log.info('entitlement_sync.no_changes', {
			userId,
			cohortId,
			duration: Date.now() - startTime,
		})
		return { toAdd: [], toRemove: [], updated: 0 }
	}

	const cohortContentAccessEntitlementType =
		await db.query.entitlementTypes.findFirst({
			where: eq(entitlementTypes.name, 'cohort_content_access'),
		})

	if (!cohortContentAccessEntitlementType) {
		throw new Error('cohort_content_access entitlement type not found')
	}

	const userMembership = await db.query.organizationMemberships.findFirst({
		where: eq(organizationMemberships.userId, userId),
	})

	if (!userMembership) {
		throw new Error(`No organization membership found for user ${userId}`)
	}

	if (!userMembership.organizationId) {
		throw new Error(`No organization ID found for user ${userId}`)
	}

	const organizationId: string = userMembership.organizationId

	// Get the purchase that grants access to this specific cohort
	// Must join with contentResourceProduct to ensure the purchase's product is linked to this cohort
	// Both Valid and Restricted purchases grant access (only Refunded is excluded)
	const purchaseResult = await db
		.select({
			id: purchases.id,
			userId: purchases.userId,
			productId: purchases.productId,
			status: purchases.status,
		})
		.from(purchases)
		.innerJoin(
			contentResourceProduct,
			eq(contentResourceProduct.productId, purchases.productId),
		)
		.where(
			and(
				eq(purchases.userId, userId),
				ne(purchases.status, 'Refunded'),
				eq(contentResourceProduct.resourceId, cohortId),
			),
		)
		.limit(1)

	const purchase = purchaseResult[0]

	if (!purchase) {
		throw new Error(
			`No valid purchase found for user ${userId} that grants access to cohort ${cohortId}`,
		)
	}

	await db.transaction(async (tx) => {
		// Remove entitlements for deleted content
		for (const contentId of changes.toRemove) {
			await tx
				.delete(entitlements)
				.where(
					and(
						eq(entitlements.userId, userId),
						eq(
							entitlements.entitlementType,
							cohortContentAccessEntitlementType.id,
						),
						eq(entitlements.sourceType, EntitlementSourceType.PURCHASE),
						eq(entitlements.sourceId, purchase.id),
						sql`JSON_CONTAINS(${entitlements.metadata}, ${JSON.stringify(contentId)}, '$.contentIds')`,
					),
				)
		}

		// Add entitlements for new content
		for (const contentId of changes.toAdd) {
			await createCohortEntitlementInTransaction(tx, {
				userId,
				resourceId: contentId,
				sourceId: purchase.id,
				organizationId: organizationId,
				organizationMembershipId: userMembership.id,
				entitlementType: cohortContentAccessEntitlementType.id,
				sourceType: EntitlementSourceType.PURCHASE,
				metadata: {
					contentIds: [contentId],
				},
			})
		}
	})

	await log.info('entitlement_sync.completed', {
		userId,
		cohortId,
		duration: Date.now() - startTime,
		entitlementsAdded: changes.toAdd.length,
		entitlementsRemoved: changes.toRemove.length,
	})

	return {
		toAdd: changes.toAdd,
		toRemove: changes.toRemove,
		updated: changes.toAdd.length + changes.toRemove.length,
	}
}

/**
 * Sync entitlements for a single user using pre-fetched cohort resource IDs.
 * This is the optimized version used by the fan-out child function.
 */
export async function syncUserCohortEntitlementsWithIds(
	userId: string,
	cohortId: string,
	cohortResourceIds: string[],
	options?: {
		allowedRemovals?: ReadonlyArray<string>
		source?: 'cms' | 'course-sync'
		controlPlaneRunId?: string
	},
): Promise<{
	toAdd: string[]
	toRemove: string[]
	updated: number
	refusedRemovals?: true
	unexpectedIdsCount?: number
}> {
	const startTime = Date.now()

	try {
		const currentEntitlements = await getCurrentCohortEntitlements(
			userId,
			cohortId,
		)

		// Calculate changes using pre-fetched resource IDs
		const changes = calculateEntitlementChangesFromIds(
			currentEntitlements,
			cohortResourceIds,
		)
		const allowed = options?.allowedRemovals
		const unexpected =
			allowed === undefined
				? []
				: changes.toRemove.filter((id) => !allowed.includes(id))
		// An unverified read may still grant new workshops. It may never revoke
		// anything beyond the plan's exact detach set for this one user.
		const safeChanges =
			unexpected.length > 0 ? { toAdd: changes.toAdd, toRemove: [] } : changes
		const result = await applyEntitlementChanges(
			userId,
			cohortId,
			safeChanges,
			startTime,
		)
		if (unexpected.length === 0) return result
		await log
			.error('cohort_entitlement_sync.bounded_removal_refused', {
				cohortId,
				affectedUserCount: 1,
				unexpectedIdsCount: unexpected.length,
				source: options?.source ?? 'course-sync',
				controlPlaneRunId: options?.controlPlaneRunId ?? null,
			})
			.catch(() => undefined)
		return {
			...result,
			refusedRemovals: true as const,
			unexpectedIdsCount: unexpected.length,
		}
	} catch (error) {
		await log.error('entitlement_sync.failed', {
			userId,
			cohortId,
			error: error instanceof Error ? error.message : String(error),
			duration: Date.now() - startTime,
		})
		throw error
	}
}
