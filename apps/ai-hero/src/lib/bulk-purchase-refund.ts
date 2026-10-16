import { db, type DbExecutor } from '@/db'
import {
	coupon,
	entitlements,
	organizationMemberships,
	purchases,
} from '@/db/schema'
import {
	EntitlementSourceType,
	softDeleteEntitlementsForPurchase,
} from '@/lib/entitlements'
import { log } from '@/server/logger'
import { and, eq, inArray, isNull } from 'drizzle-orm'

/**
 * Get all purchases related to a bulk purchase (original + all redeemed seats)
 * @param originalPurchase - The original bulk purchase
 * @returns Array of all related purchases
 */
export async function getAllRelatedPurchases(originalPurchase: any) {
	if (!originalPurchase.bulkCouponId) {
		// Not a bulk purchase, return just the original
		return [originalPurchase]
	}

	// Add-seat purchases can share a coupon. A surviving paid parent still
	// funds the claimed seats, so only revoke this parent's own grants.
	if (await hasSurvivingBulkParent(originalPurchase)) {
		return [originalPurchase]
	}

	// Find all purchases that redeemed this bulk coupon
	const redeemedPurchases = await db.query.purchases.findMany({
		where: eq(purchases.redeemedBulkCouponId, originalPurchase.bulkCouponId),
		with: {
			user: true,
		},
	})

	await log.info('bulk_refund.found_related_purchases', {
		originalPurchaseId: originalPurchase.id,
		bulkCouponId: originalPurchase.bulkCouponId,
		redeemedPurchasesCount: redeemedPurchases.length,
		redeemedUserIds: redeemedPurchases.map((p) => p.userId),
	})

	return [originalPurchase, ...redeemedPurchases]
}

async function hasSurvivingBulkParent(originalPurchase: any) {
	if (!originalPurchase.bulkCouponId) return false
	const parents = await db.query.purchases.findMany({
		where: eq(purchases.bulkCouponId, originalPurchase.bulkCouponId),
	})
	return parents.some(
		(parent) =>
			parent.id !== originalPurchase.id &&
			(parent.status === 'Valid' || parent.status === 'Restricted'),
	)
}

/**
 * Remove organization membership for a user from a specific organization
 * Only removes if the user is not the owner and it's not their personal org
 * @param userId - The user ID to remove
 * @param organizationId - The organization to remove them from
 */
export async function removeOrganizationMembership(
	userId: string,
	organizationId: string,
) {
	try {
		// Find the membership
		const membership = await db.query.organizationMemberships.findFirst({
			where: and(
				eq(organizationMemberships.userId, userId),
				eq(organizationMemberships.organizationId, organizationId),
			),
		})

		if (!membership) {
			await log.warn('bulk_refund.membership_not_found', {
				userId,
				organizationId,
			})
			return { removed: false, reason: 'membership_not_found' }
		}

		// Check if user is an owner of this organization
		// For now, we'll be conservative and not remove memberships for safety
		// In a real implementation, you'd query the organizationRoles table
		const isOwner = membership.role === 'owner'

		if (isOwner) {
			await log.warn('bulk_refund.cannot_remove_owner', {
				userId,
				organizationId,
				membershipId: membership.id,
			})
			return { removed: false, reason: 'is_owner' }
		}

		// Session access is loaded through membership. Preserve it for any live
		// grant (including manual grants) or paid purchase in this organization.
		const remainingEntitlements = await db.query.entitlements.findMany({
			where: and(
				eq(entitlements.organizationMembershipId, membership.id),
				isNull(entitlements.deletedAt),
			),
		})
		const remainingPurchase = await db.query.purchases.findFirst({
			where: and(
				eq(purchases.userId, userId),
				eq(purchases.organizationId, organizationId),
				inArray(purchases.status, ['Valid', 'Restricted']),
			),
		})
		if (
			remainingPurchase ||
			remainingEntitlements.some(
				(entitlement) =>
					!entitlement.expiresAt || entitlement.expiresAt > new Date(),
			)
		) {
			return { removed: false, reason: 'surviving_access' }
		}

		// Remove the organization membership
		await db
			.delete(organizationMemberships)
			.where(eq(organizationMemberships.id, membership.id))

		await log.info('bulk_refund.membership_removed', {
			userId,
			organizationId,
			membershipId: membership.id,
		})

		return { removed: true, membershipId: membership.id }
	} catch (error) {
		await log.error('bulk_refund.membership_removal_failed', {
			userId,
			organizationId,
			error: error instanceof Error ? error.message : String(error),
		})
		throw error
	}
}

/**
 * Remove Discord role entitlements for a user in a specific organization
 * @param userId - The user ID
 * @param organizationId - The organization ID
 * @param productId - The product ID to scope Discord role removal
 */
export async function removeDiscordRoleEntitlements(
	userId: string,
	organizationId: string,
	productId: string,
) {
	try {
		// Remove both workshop and cohort Discord role entitlements
		const discordEntitlementTypes = [
			'workshop_discord_role',
			'cohort_discord_role',
		]

		let totalRemoved = 0

		for (const entitlementType of discordEntitlementTypes) {
			const result = await db
				.update(entitlements)
				.set({ deletedAt: new Date() })
				.where(
					and(
						eq(entitlements.userId, userId),
						eq(entitlements.organizationId, organizationId),
						eq(entitlements.entitlementType, entitlementType),
						eq(entitlements.sourceType, EntitlementSourceType.PURCHASE),
						isNull(entitlements.deletedAt),
					),
				)

			totalRemoved += result.rowsAffected || 0
		}

		await log.info('bulk_refund.discord_roles_removed', {
			userId,
			organizationId,
			productId,
			entitlementsRemoved: totalRemoved,
		})

		return { entitlementsRemoved: totalRemoved }
	} catch (error) {
		await log.error('bulk_refund.discord_role_removal_failed', {
			userId,
			organizationId,
			productId,
			error: error instanceof Error ? error.message : String(error),
		})
		throw error
	}
}

/**
 * Comprehensive refund for bulk purchases - removes all team member access
 * @param originalPurchase - The original bulk purchase to refund
 * @returns Summary of refund operations
 */
export async function refundBulkPurchaseEntitlements(originalPurchase: any) {
	const startTime = Date.now()

	try {
		// Step 1: Get all related purchases (original + claimed seats)
		const allPurchases = await getAllRelatedPurchases(originalPurchase)

		await log.info('bulk_refund.starting_refund', {
			originalPurchaseId: originalPurchase.id,
			bulkCouponId: originalPurchase.bulkCouponId,
			organizationId: originalPurchase.organizationId,
			totalPurchasesToRefund: allPurchases.length,
			affectedUserIds: allPurchases.map((p) => p.userId),
		})

		// Step 2: Remove entitlements and update purchase status for all purchases
		const entitlementResults = []
		const purchaseStatusResults = []

		const refundedPurchases = []
		for (const purchase of allPurchases) {
			const cleanup = async (executor: DbExecutor) => {
				if (purchase.id !== originalPurchase.id) {
					// Lock every parent sharing the coupon in the same transaction as
					// seat deletion/status update. Discovery alone is not authoritative.
					const parents = await executor
						.select()
						.from(purchases)
						.where(eq(purchases.bulkCouponId, originalPurchase.bulkCouponId))
						.for('update')
					if (
						parents.some(
							(parent) =>
								parent.id !== originalPurchase.id &&
								(parent.status === 'Valid' || parent.status === 'Restricted'),
						)
					)
						return null
				}
				const result = await softDeleteEntitlementsForPurchase(
					purchase.id,
					executor,
				)
				const statusResult = await executor
					.update(purchases)
					.set({ status: 'Refunded' })
					.where(eq(purchases.id, purchase.id))
				return { result, statusResult }
			}
			const cleaned =
				purchase.id === originalPurchase.id
					? await cleanup(db)
					: await db.transaction(cleanup)
			if (!cleaned) continue
			refundedPurchases.push(purchase)
			const { result, statusResult } = cleaned
			entitlementResults.push({
				purchaseId: purchase.id,
				userId: purchase.userId,
				rowsAffected: result.rowsAffected || 0,
			})

			purchaseStatusResults.push({
				purchaseId: purchase.id,
				userId: purchase.userId,
				statusUpdated: (statusResult.rowsAffected || 0) > 0,
			})

			// Source-scoped deletion above already includes Discord grants.
			// Do not widen deletion to other purchases in the organization.
		}

		// Step 3: Remove organization memberships for redeemed users only
		// Keep the original purchaser in their organization (it might be their personal org)
		const membershipResults = []
		const redeemedPurchases = refundedPurchases.filter(
			(p) => p.id !== originalPurchase.id,
		)

		for (const purchase of redeemedPurchases) {
			// Extra safety: Never remove the original purchaser's organization membership
			// even if they claimed a seat for themselves
			if (
				originalPurchase.organizationId &&
				purchase.userId !== originalPurchase.userId
			) {
				const result = await removeOrganizationMembership(
					purchase.userId,
					originalPurchase.organizationId,
				)
				membershipResults.push({
					userId: purchase.userId,
					...result,
				})
			} else if (purchase.userId === originalPurchase.userId) {
				await log.info('bulk_refund.skipped_original_purchaser_membership', {
					originalPurchaseId: originalPurchase.id,
					userId: purchase.userId,
					reason: 'original_purchaser_should_keep_org_access',
				})
			}
		}

		// Step 4: Revoke bulk coupon to prevent further invitations
		let couponRevoked = false
		if (
			originalPurchase.bulkCouponId &&
			!(await hasSurvivingBulkParent(originalPurchase))
		) {
			try {
				const revokeResult = await revokeBulkCouponInviteAbility(
					originalPurchase.bulkCouponId,
				)
				couponRevoked = revokeResult.revoked
			} catch (error) {
				await log.error('bulk_refund.coupon_revocation_error', {
					originalPurchaseId: originalPurchase.id,
					bulkCouponId: originalPurchase.bulkCouponId,
					error: error instanceof Error ? error.message : String(error),
				})
				throw error
			}
		}

		const totalEntitlementsRemoved = entitlementResults.reduce(
			(sum, result) => sum + result.rowsAffected,
			0,
		)
		const totalMembershipsRemoved = membershipResults.filter(
			(r) => r.removed,
		).length
		const totalPurchasesMarkedRefunded = purchaseStatusResults.filter(
			(r) => r.statusUpdated,
		).length

		await log.info('bulk_refund.completed', {
			originalPurchaseId: originalPurchase.id,
			bulkCouponId: originalPurchase.bulkCouponId,
			duration: Date.now() - startTime,
			totalPurchasesRefunded: refundedPurchases.length,
			totalEntitlementsRemoved,
			totalMembershipsRemoved,
			totalPurchasesMarkedRefunded,
			couponRevoked,
			affectedUsers: refundedPurchases.length,
		})

		return {
			success: true,
			originalPurchaseId: originalPurchase.id,
			totalPurchasesRefunded: refundedPurchases.length,
			totalEntitlementsRemoved,
			totalMembershipsRemoved,
			totalPurchasesMarkedRefunded,
			couponRevoked,
			affectedUsers: refundedPurchases.map((p) => ({
				userId: p.userId,
				purchaseId: p.id,
				email: p.user?.email,
			})),
			entitlementResults,
			membershipResults,
			purchaseStatusResults,
		}
	} catch (error) {
		await log.error('bulk_refund.failed', {
			originalPurchaseId: originalPurchase.id,
			bulkCouponId: originalPurchase.bulkCouponId,
			duration: Date.now() - startTime,
			error: error instanceof Error ? error.message : String(error),
		})

		return {
			success: false,
			originalPurchaseId: originalPurchase.id,
			error: error instanceof Error ? error.message : String(error),
			affectedUsers: [],
		}
	}
}

/**
 * Check if a purchase is a bulk purchase that affects multiple users
 * @param purchase - The purchase to check
 * @returns Boolean indicating if this is a bulk purchase
 */
export function isBulkPurchase(purchase: any): boolean {
	return Boolean(purchase.bulkCouponId)
}

/**
 * Revoke bulk coupon invite ability by setting its status to inactive
 * @param bulkCouponId - The bulk coupon ID to revoke
 */
export async function revokeBulkCouponInviteAbility(bulkCouponId: string) {
	try {
		// Set coupon status to 0 (inactive) to prevent further invitations
		const result = await db
			.update(coupon)
			.set({
				status: 0, // 0 = inactive, 1 = active
			})
			.where(eq(coupon.id, bulkCouponId))

		await log.info('bulk_refund.coupon_revoked', {
			bulkCouponId,
			rowsAffected: result.rowsAffected || 0,
		})

		return {
			revoked: true,
			rowsAffected: result.rowsAffected || 0,
		}
	} catch (error) {
		await log.error('bulk_refund.coupon_revocation_failed', {
			bulkCouponId,
			error: error instanceof Error ? error.message : String(error),
		})
		throw error
	}
}
