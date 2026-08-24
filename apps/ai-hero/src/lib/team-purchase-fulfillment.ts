import { db } from '@/db'
import {
	coupon,
	organizationMembershipRoles,
	organizationMemberships,
	purchases,
	roles,
} from '@/db/schema'
import { isTeamPurchaseManagerRole } from '@/lib/team-roles'
import { and, eq, isNull, sql } from 'drizzle-orm'

export type TeamPurchaseFulfillmentRole = {
	active: boolean
	deletedAt: Date | null
	role: {
		name: string
		active: boolean
		deletedAt: Date | null
	}
}

export type TeamPurchaseFulfillmentMembership = {
	id: string
	organizationId: string
	organizationMembershipRoles: TeamPurchaseFulfillmentRole[]
}

export type RelatedBulkPurchase = {
	id: string
	createdAt: Date
	organizationId: string | null
	purchasedByOrganizationMembershipId: string | null
}

export type TeamPurchaseFulfillmentPurchase = {
	id: string
	userId: string | null
	createdAt: Date
	status: string
	bulkCouponId: string | null
	organizationId: string | null
	purchasedByOrganizationMembershipId: string | null
	bulkCouponOrganizationId: string | null
	relatedBulkPurchases: RelatedBulkPurchase[]
}

export type TeamPurchaseCommitConflictReason =
	| 'concurrent-update'
	| 'add-seat-purchase-already-linked'
	| 'link-target-missing'
	| 'manager-role-changed'
	| 'link-readback-failed'

export type TeamPurchaseReviewReason =
	| TeamPurchaseCommitConflictReason
	| 'buyer-missing'
	| 'organization-conflict'
	| 'purchase-membership-conflict'
	| 'manager-membership-ambiguous'
	| 'manager-role-required'
	| 'manager-role-inactive'
	| 'add-seat-purchase-already-linked'

export type TeamPurchaseLinkInput = {
	purchaseId: string
	bulkCouponId: string
	expectedPurchaseStatus: string
	expectedPurchaseCreatedAt: Date
	expectedPurchaseOrganizationId: string | null
	expectedPurchaseMembershipId: string | null
	expectedCouponOrganizationId: string | null
	targetOrganizationId: string
	targetMembershipId: string
	userId: string
}

export type TeamPurchaseFulfillmentDataSource = {
	loadPurchase(
		purchaseId: string,
	): Promise<TeamPurchaseFulfillmentPurchase | null>
	loadMemberships(
		userId: string,
	): Promise<TeamPurchaseFulfillmentMembership[]>
	commitLink(
		input: TeamPurchaseLinkInput,
	): Promise<
		| { status: 'linked' }
		| {
				status: 'add-seat-extension'
				canonicalPurchaseId: string
				organizationId: string | null
			}
		| { status: 'conflict'; reason: TeamPurchaseCommitConflictReason }
	>
}

export type TeamPurchaseFulfillmentResult =
	| {
			status: 'linked' | 'already-linked'
			purchaseId: string
			bulkCouponId: string
			organizationId: string
			organizationMembershipId: string
	  }
	| {
			status: 'add-seat-extension'
			purchaseId: string
			bulkCouponId: string
			organizationId: string | null
			canonicalPurchaseId: string
	  }
	| {
			status: 'requires-review'
			purchaseId: string
			reason: TeamPurchaseReviewReason
	  }
	| {
			status: 'skipped'
			purchaseId: string
			reason: 'not-a-fulfillable-team-purchase'
	  }

const FULFILLABLE_PURCHASE_STATES = new Set(['Valid', 'Restricted'])

function hasActiveManagerRole(
	membership: TeamPurchaseFulfillmentMembership,
): boolean {
	return membership.organizationMembershipRoles.some(
		(membershipRole) =>
			membershipRole.active &&
			!membershipRole.deletedAt &&
			membershipRole.role.active &&
			!membershipRole.role.deletedAt &&
			isTeamPurchaseManagerRole(membershipRole.role.name),
	)
}

function hasInactiveManagerRole(
	membership: TeamPurchaseFulfillmentMembership,
): boolean {
	return membership.organizationMembershipRoles.some((membershipRole) =>
		isTeamPurchaseManagerRole(membershipRole.role.name),
	)
}

function requiresReview(
	purchaseId: string,
	reason: TeamPurchaseReviewReason,
): TeamPurchaseFulfillmentResult {
	return { status: 'requires-review', purchaseId, reason }
}

function compareBulkPurchases(
	left: Pick<RelatedBulkPurchase, 'id' | 'createdAt'>,
	right: Pick<RelatedBulkPurchase, 'id' | 'createdAt'>,
) {
	return left.createdAt.getTime() - right.createdAt.getTime() ||
		left.id.localeCompare(right.id)
}

function getCanonicalBulkPurchase(
	purchase: TeamPurchaseFulfillmentPurchase,
): RelatedBulkPurchase {
	return [
		{
			id: purchase.id,
			createdAt: purchase.createdAt,
			organizationId: purchase.organizationId,
			purchasedByOrganizationMembershipId:
				purchase.purchasedByOrganizationMembershipId,
		},
		...purchase.relatedBulkPurchases,
	].sort(compareBulkPurchases)[0]!
}

export async function reconcileTeamPurchaseFulfillment(
	purchaseId: string,
	dataSource: TeamPurchaseFulfillmentDataSource =
		drizzleTeamPurchaseFulfillmentDataSource,
): Promise<TeamPurchaseFulfillmentResult> {
	const purchase = await dataSource.loadPurchase(purchaseId)
	if (!purchase) return requiresReview(purchaseId, 'link-target-missing')

	if (
		!purchase.bulkCouponId ||
		!FULFILLABLE_PURCHASE_STATES.has(purchase.status)
	) {
		return {
			status: 'skipped',
			purchaseId,
			reason: 'not-a-fulfillable-team-purchase',
		}
	}
	if (!purchase.userId) return requiresReview(purchase.id, 'buyer-missing')

	if (
		purchase.organizationId &&
		purchase.bulkCouponOrganizationId &&
		purchase.organizationId !== purchase.bulkCouponOrganizationId
	) {
		return requiresReview(purchase.id, 'organization-conflict')
	}

	const linkedSiblingOrganizations = new Set(
		purchase.relatedBulkPurchases.flatMap((relatedPurchase) =>
			relatedPurchase.organizationId
				? [relatedPurchase.organizationId]
				: [],
		),
	)
	if (
		linkedSiblingOrganizations.size > 1 ||
		(purchase.bulkCouponOrganizationId &&
			linkedSiblingOrganizations.size === 1 &&
			!linkedSiblingOrganizations.has(purchase.bulkCouponOrganizationId))
	) {
		return requiresReview(purchase.id, 'organization-conflict')
	}

	const canonicalPurchase = getCanonicalBulkPurchase(purchase)
	if (canonicalPurchase.id !== purchase.id) {
		if (
			purchase.organizationId ||
			purchase.purchasedByOrganizationMembershipId
		) {
			return requiresReview(
				purchase.id,
				'add-seat-purchase-already-linked',
			)
		}
		return {
			status: 'add-seat-extension',
			purchaseId: purchase.id,
			bulkCouponId: purchase.bulkCouponId,
			organizationId:
				purchase.bulkCouponOrganizationId ?? canonicalPurchase.organizationId,
			canonicalPurchaseId: canonicalPurchase.id,
		}
	}
	if (linkedSiblingOrganizations.size > 0) {
		return requiresReview(
			purchase.id,
			'add-seat-purchase-already-linked',
		)
	}

	const memberships = await dataSource.loadMemberships(purchase.userId)
	const existingOrganizationId =
		purchase.organizationId ?? purchase.bulkCouponOrganizationId

	if (
		purchase.organizationId &&
		purchase.purchasedByOrganizationMembershipId &&
		purchase.bulkCouponOrganizationId === purchase.organizationId
	) {
		const linkedMembership = memberships.find(
			(membership) =>
				membership.id === purchase.purchasedByOrganizationMembershipId &&
				membership.organizationId === purchase.organizationId,
		)
		if (!linkedMembership) {
			return requiresReview(purchase.id, 'purchase-membership-conflict')
		}

		// Organization governance can intentionally remove authority after
		// fulfillment. A replay must never restore it.
		return {
			status: 'already-linked',
			purchaseId: purchase.id,
			bulkCouponId: purchase.bulkCouponId,
			organizationId: purchase.organizationId,
			organizationMembershipId: linkedMembership.id,
		}
	}

	let targetMembership: TeamPurchaseFulfillmentMembership | undefined
	if (existingOrganizationId) {
		const organizationMembership = memberships.find(
			(membership) => membership.organizationId === existingOrganizationId,
		)
		if (!organizationMembership) {
			return requiresReview(purchase.id, 'manager-role-required')
		}
		if (!hasActiveManagerRole(organizationMembership)) {
			return requiresReview(
				purchase.id,
				hasInactiveManagerRole(organizationMembership)
					? 'manager-role-inactive'
					: 'manager-role-required',
			)
		}
		targetMembership = organizationMembership
	} else {
		const managerMemberships = memberships.filter(hasActiveManagerRole)
		if (managerMemberships.length > 1) {
			return requiresReview(purchase.id, 'manager-membership-ambiguous')
		}
		if (managerMemberships.length === 0) {
			const hasInactiveManager = memberships.some(hasInactiveManagerRole)
			return requiresReview(
				purchase.id,
				hasInactiveManager ? 'manager-role-inactive' : 'manager-role-required',
			)
		}
		targetMembership = managerMemberships[0]
	}

	if (!targetMembership) {
		return requiresReview(purchase.id, 'manager-role-required')
	}
	if (
		purchase.purchasedByOrganizationMembershipId &&
		purchase.purchasedByOrganizationMembershipId !== targetMembership.id
	) {
		return requiresReview(purchase.id, 'purchase-membership-conflict')
	}

	const commitResult = await dataSource.commitLink({
		purchaseId: purchase.id,
		bulkCouponId: purchase.bulkCouponId,
		expectedPurchaseStatus: purchase.status,
		expectedPurchaseCreatedAt: purchase.createdAt,
		expectedPurchaseOrganizationId: purchase.organizationId,
		expectedPurchaseMembershipId:
			purchase.purchasedByOrganizationMembershipId,
		expectedCouponOrganizationId: purchase.bulkCouponOrganizationId,
		targetOrganizationId: targetMembership.organizationId,
		targetMembershipId: targetMembership.id,
		userId: purchase.userId,
	})
	if (commitResult.status === 'conflict') {
		return requiresReview(purchase.id, commitResult.reason)
	}
	if (commitResult.status === 'add-seat-extension') {
		return {
			...commitResult,
			purchaseId: purchase.id,
			bulkCouponId: purchase.bulkCouponId,
		}
	}

	return {
		status: 'linked',
		purchaseId: purchase.id,
		bulkCouponId: purchase.bulkCouponId,
		organizationId: targetMembership.organizationId,
		organizationMembershipId: targetMembership.id,
	}
}

class LinkTransactionConflict extends Error {
	constructor(readonly reason: TeamPurchaseCommitConflictReason) {
		super(reason)
	}
}

function getRowsAffected(result: unknown): number {
	if (
		result &&
		typeof result === 'object' &&
		'rowsAffected' in result &&
		typeof result.rowsAffected === 'number'
	) {
		return result.rowsAffected
	}
	if (Array.isArray(result)) {
		const header = result[0]
		if (
			header &&
			typeof header === 'object' &&
			'affectedRows' in header &&
			typeof header.affectedRows === 'number'
		) {
			return header.affectedRows
		}
	}
	return 0
}

export function teamPurchaseLinkCompareAndSetWhere(
	input: TeamPurchaseLinkInput,
) {
	return and(
		eq(purchases.id, input.purchaseId),
		eq(purchases.userId, input.userId),
		eq(purchases.bulkCouponId, input.bulkCouponId),
		eq(purchases.createdAt, input.expectedPurchaseCreatedAt),
		eq(purchases.status, input.expectedPurchaseStatus),
		input.expectedPurchaseOrganizationId === null
			? isNull(purchases.organizationId)
			: eq(
					purchases.organizationId,
					input.expectedPurchaseOrganizationId,
				),
		input.expectedPurchaseMembershipId === null
			? isNull(purchases.purchasedByorganizationMembershipId)
			: eq(
					purchases.purchasedByorganizationMembershipId,
					input.expectedPurchaseMembershipId,
				),
	)
}

async function loadMembershipForReadback(
	client: typeof db,
	membershipId: string,
) {
	return client.query.organizationMemberships.findFirst({
		where: eq(organizationMemberships.id, membershipId),
		with: {
			organizationMembershipRoles: { with: { role: true } },
		},
	})
}

export function createDrizzleTeamPurchaseFulfillmentDataSource(
	database: typeof db,
): TeamPurchaseFulfillmentDataSource {
	return {
		async loadPurchase(purchaseId) {
			const purchase = await database.query.purchases.findFirst({
				where: eq(purchases.id, purchaseId),
				with: {
					bulkCoupon: { with: { bulkPurchases: true } },
				},
			})
			if (!purchase) return null

			return {
				id: purchase.id,
				userId: purchase.userId,
				createdAt: purchase.createdAt,
				status: purchase.status,
				bulkCouponId: purchase.bulkCouponId,
				organizationId: purchase.organizationId,
				purchasedByOrganizationMembershipId:
					purchase.purchasedByorganizationMembershipId,
				bulkCouponOrganizationId:
					purchase.bulkCoupon?.organizationId ?? null,
				relatedBulkPurchases:
					purchase.bulkCoupon?.bulkPurchases
						.filter((relatedPurchase) => relatedPurchase.id !== purchase.id)
						.map((relatedPurchase) => ({
							id: relatedPurchase.id,
							createdAt: relatedPurchase.createdAt,
							organizationId: relatedPurchase.organizationId,
							purchasedByOrganizationMembershipId:
								relatedPurchase.purchasedByorganizationMembershipId,
						})) ?? [],
			}
		},

		async loadMemberships(userId) {
			const memberships = await database.query.organizationMemberships.findMany({
				where: eq(organizationMemberships.userId, userId),
				with: {
					organizationMembershipRoles: { with: { role: true } },
				},
			})

			return memberships.flatMap((membership) =>
				membership.organizationId
					? [
							{
								id: membership.id,
								organizationId: membership.organizationId,
								organizationMembershipRoles:
									membership.organizationMembershipRoles.map(
										(membershipRole) => ({
											active: membershipRole.active,
											deletedAt: membershipRole.deletedAt,
											role: {
												name: membershipRole.role.name,
												active: membershipRole.role.active,
												deletedAt: membershipRole.role.deletedAt,
											},
										}),
									),
							},
						]
					: [],
			)
		},

		async commitLink(input) {
			try {
				return await database.transaction(async (transaction) => {
					// The coupon row is the indexed mutex for the seat pool. Lock only the
					// current purchase by primary key; locking siblings by bulkCouponId would
					// scan and lock the whole Purchase table because that column is unindexed.
					await transaction.execute(
						sql`SELECT ${coupon.id} FROM ${coupon} WHERE ${coupon.id} = ${input.bulkCouponId} FOR UPDATE`,
					)
					await transaction.execute(
						sql`SELECT ${purchases.id} FROM ${purchases} WHERE ${purchases.id} = ${input.purchaseId} FOR UPDATE`,
					)
					await transaction.execute(
						sql`SELECT ${organizationMemberships.id} FROM ${organizationMemberships} WHERE ${organizationMemberships.id} = ${input.targetMembershipId} FOR UPDATE`,
					)
					await transaction.execute(
						sql`SELECT ${organizationMembershipRoles.roleId} FROM ${organizationMembershipRoles} WHERE ${organizationMembershipRoles.organizationMembershipId} = ${input.targetMembershipId} FOR UPDATE`,
					)
					await transaction.execute(
						sql`SELECT ${roles.id} FROM ${roles} WHERE ${roles.organizationId} = ${input.targetOrganizationId} AND (${roles.name} = 'owner' OR ${roles.name} = 'billing_admin') FOR UPDATE`,
					)

					const currentPurchase = await transaction.query.purchases.findFirst({
						where: eq(purchases.id, input.purchaseId),
					})
					const currentCoupon = await transaction.query.coupon.findFirst({
						where: eq(coupon.id, input.bulkCouponId),
					})
					const siblingPurchases = await transaction.query.purchases.findMany({
						where: eq(purchases.bulkCouponId, input.bulkCouponId),
					})
					if (!currentPurchase || !currentCoupon) {
						throw new LinkTransactionConflict('link-target-missing')
					}
					if (
						currentPurchase.userId !== input.userId ||
						currentPurchase.bulkCouponId !== input.bulkCouponId ||
						currentPurchase.status !== input.expectedPurchaseStatus ||
						currentPurchase.createdAt.getTime() !==
							input.expectedPurchaseCreatedAt.getTime() ||
						currentPurchase.organizationId !==
							input.expectedPurchaseOrganizationId ||
						currentPurchase.purchasedByorganizationMembershipId !==
							input.expectedPurchaseMembershipId ||
						currentCoupon.organizationId !==
							input.expectedCouponOrganizationId
					) {
						throw new LinkTransactionConflict('concurrent-update')
					}

					const canonicalPurchase = [...siblingPurchases]
						.sort(compareBulkPurchases)[0]
					if (!canonicalPurchase) {
						throw new LinkTransactionConflict('link-target-missing')
					}
					if (canonicalPurchase.id !== input.purchaseId) {
						if (
							currentPurchase.organizationId ||
							currentPurchase.purchasedByorganizationMembershipId
						) {
							throw new LinkTransactionConflict(
								'add-seat-purchase-already-linked',
							)
						}
						return {
							status: 'add-seat-extension' as const,
							canonicalPurchaseId: canonicalPurchase.id,
							organizationId:
								currentCoupon.organizationId ?? canonicalPurchase.organizationId,
						}
					}
					const linkedSibling = siblingPurchases.find(
						(siblingPurchase) =>
							siblingPurchase.id !== input.purchaseId &&
							Boolean(siblingPurchase.organizationId),
					)
					if (linkedSibling) {
						throw new LinkTransactionConflict(
							'add-seat-purchase-already-linked',
						)
					}

					const managerMembership = await loadMembershipForReadback(
						transaction as typeof db,
						input.targetMembershipId,
					)
					if (
						!managerMembership ||
						managerMembership.userId !== input.userId ||
						managerMembership.organizationId !== input.targetOrganizationId ||
						!hasActiveManagerRole({
							id: managerMembership.id,
							organizationId: input.targetOrganizationId,
							organizationMembershipRoles:
								managerMembership.organizationMembershipRoles,
						})
					) {
						throw new LinkTransactionConflict('manager-role-changed')
					}

					const purchaseUpdate = await transaction
						.update(purchases)
						.set({
							organizationId: input.targetOrganizationId,
							purchasedByorganizationMembershipId: input.targetMembershipId,
						})
						.where(teamPurchaseLinkCompareAndSetWhere(input))
					if (getRowsAffected(purchaseUpdate) !== 1) {
						throw new LinkTransactionConflict('concurrent-update')
					}

					if (
						input.expectedCouponOrganizationId !== input.targetOrganizationId
					) {
						const couponUpdate = await transaction
							.update(coupon)
							.set({ organizationId: input.targetOrganizationId })
							.where(
								and(
									eq(coupon.id, input.bulkCouponId),
									input.expectedCouponOrganizationId === null
										? isNull(coupon.organizationId)
										: eq(
												coupon.organizationId,
												input.expectedCouponOrganizationId,
											),
								),
							)
						if (getRowsAffected(couponUpdate) !== 1) {
							throw new LinkTransactionConflict('concurrent-update')
						}
					}

					const linkedPurchase = await transaction.query.purchases.findFirst({
						where: eq(purchases.id, input.purchaseId),
					})
					const linkedCoupon = await transaction.query.coupon.findFirst({
						where: eq(coupon.id, input.bulkCouponId),
					})
					const linkedMembership = await loadMembershipForReadback(
						transaction as typeof db,
						input.targetMembershipId,
					)
					if (
						linkedPurchase?.userId !== input.userId ||
						linkedPurchase?.bulkCouponId !== input.bulkCouponId ||
						linkedPurchase.organizationId !== input.targetOrganizationId ||
						linkedPurchase.purchasedByorganizationMembershipId !==
							input.targetMembershipId ||
						linkedCoupon?.organizationId !== input.targetOrganizationId ||
						linkedMembership?.userId !== input.userId ||
						linkedMembership.organizationId !== input.targetOrganizationId ||
						!hasActiveManagerRole({
							id: linkedMembership.id,
							organizationId: input.targetOrganizationId,
							organizationMembershipRoles:
								linkedMembership.organizationMembershipRoles,
						})
					) {
						throw new LinkTransactionConflict('link-readback-failed')
					}
					return { status: 'linked' as const }
				})
			} catch (error) {
				if (error instanceof LinkTransactionConflict) {
					return { status: 'conflict', reason: error.reason }
				}
				throw error
			}
		},
	}
}

export const drizzleTeamPurchaseFulfillmentDataSource =
	createDrizzleTeamPurchaseFulfillmentDataSource(db)
