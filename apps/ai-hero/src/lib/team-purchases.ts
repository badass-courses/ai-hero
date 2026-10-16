import { organizationMemberships, purchases } from '@/db/schema'
import {
	BILLING_ADMIN_ROLE,
	isTeamPurchaseManagerRole,
} from '@/lib/team-roles'
import { and, asc, eq, inArray, isNotNull } from 'drizzle-orm'

import {
	purchaseSchema,
	type Purchase,
} from '@coursebuilder/core/schemas'

export { BILLING_ADMIN_ROLE } from '@/lib/team-roles'
const VISIBLE_PURCHASE_STATES = new Set(['Valid', 'Refunded', 'Restricted'])

/**
 * What a team card on `/team` may offer. Seat and invite actions exist only
 * for `active`; every other state names why they are gone.
 *
 * - `refunded`: the purchase was refunded and its coupon is deactivated.
 * - `setting-up`: the viewer paid for the pool, but no organization they
 *   manage holds it. Shown as a state only; the page never writes.
 * - `coupon-inactive`: a live purchase whose seat coupon is off.
 */
export type TeamCardState =
	| 'active'
	| 'refunded'
	| 'setting-up'
	| 'coupon-inactive'

export function getTeamCardState({
	purchaseStatus,
	managedByViewer,
	couponActive,
}: {
	purchaseStatus: string
	managedByViewer: boolean
	couponActive: boolean
}): TeamCardState {
	if (purchaseStatus === 'Refunded') return 'refunded'
	if (!managedByViewer) return 'setting-up'
	if (!couponActive) return 'coupon-inactive'
	return 'active'
}

/**
 * Bulk purchases the viewer bought that no managed organization holds: no
 * organization, or an organization the viewer has no manager membership in.
 */
export function getUnlinkedBulkPurchases(
	ownedBulkPurchases: Purchase[],
	managedPurchases: Pick<Purchase, 'id'>[],
): Purchase[] {
	const managedIds = new Set(managedPurchases.map(({ id }) => id))
	return ownedBulkPurchases.filter(
		(purchase) =>
			Boolean(purchase.bulkCouponId) &&
			VISIBLE_PURCHASE_STATES.has(purchase.status) &&
			!managedIds.has(purchase.id),
	)
}

export type TeamPurchaseMembership = {
	organizationId: string
	organizationMembershipRoles: {
		active: boolean
		deletedAt: Date | null
		role: {
			active: boolean
			deletedAt: Date | null
			name: string
		}
	}[]
}

export type TeamPurchaseDataSource = {
	loadMembershipsForUser(userId: string): Promise<TeamPurchaseMembership[]>
	loadBulkPurchasesForOrganizations(
		organizationIds: string[],
	): Promise<Purchase[]>
	loadBulkPurchasesOwnedByUser?(userId: string): Promise<Purchase[]>
}

export function getManagedOrganizationIds(
	memberships: TeamPurchaseMembership[],
): string[] {
	return Array.from(
		new Set(
			memberships.flatMap((membership) => {
				const canManageTeamPurchases =
					membership.organizationMembershipRoles.some(
						(membershipRole) =>
							membershipRole.active &&
							!membershipRole.deletedAt &&
							membershipRole.role.active &&
							!membershipRole.role.deletedAt &&
							isTeamPurchaseManagerRole(membershipRole.role.name),
					)

				return canManageTeamPurchases ? [membership.organizationId] : []
			}),
		),
	)
}

export function canViewPurchaseInvoice(
	viewerUserId: string | null | undefined,
	purchase: Pick<Purchase, 'id' | 'userId'> & {
		billingUserId?: string | null
	},
	managedTeamPurchases: Pick<Purchase, 'id'>[],
): boolean {
	if (!viewerUserId) return false
	const billingOwnerId = purchase.billingUserId ?? purchase.userId
	return (
		billingOwnerId === viewerUserId ||
		managedTeamPurchases.some((managedPurchase) => managedPurchase.id === purchase.id)
	)
}

export async function getTeamPurchasesForMember(
	userId: string | null | undefined,
	dataSource: TeamPurchaseDataSource = drizzleTeamPurchaseDataSource,
): Promise<Purchase[]> {
	if (!userId) return []

	const memberships = await dataSource.loadMembershipsForUser(userId)
	const organizationIds = getManagedOrganizationIds(memberships)
	if (organizationIds.length === 0) return []

	const authorizedOrganizationIds = new Set(organizationIds)
	const teamPurchases =
		await dataSource.loadBulkPurchasesForOrganizations(organizationIds)

	// The repository query is scoped too. This second check keeps a malformed or
	// replaced repository from leaking another organization's purchase.
	return teamPurchases.filter(
		(purchase) =>
			Boolean(purchase.bulkCouponId) &&
			Boolean(
				purchase.organizationId &&
					authorizedOrganizationIds.has(purchase.organizationId),
			) &&
			VISIBLE_PURCHASE_STATES.has(purchase.status),
	)
}

/** Read only. Never creates an organization or membership. */
export async function getUnlinkedBulkPurchasesForUser(
	userId: string | null | undefined,
	managedPurchases: Pick<Purchase, 'id'>[],
	dataSource: TeamPurchaseDataSource = drizzleTeamPurchaseDataSource,
): Promise<Purchase[]> {
	if (!userId || !dataSource.loadBulkPurchasesOwnedByUser) return []
	const owned = await dataSource.loadBulkPurchasesOwnedByUser(userId)
	return getUnlinkedBulkPurchases(
		owned.filter((purchase) => purchase.userId === userId),
		managedPurchases,
	)
}

export const drizzleTeamPurchaseDataSource: TeamPurchaseDataSource = {
	async loadMembershipsForUser(userId) {
		const { db } = await import('@/db')
		const rows = await db.query.organizationMemberships.findMany({
			where: eq(organizationMemberships.userId, userId),
			with: {
				organizationMembershipRoles: {
					with: {
						role: true,
					},
				},
			},
		})

		return rows.flatMap((membership) =>
			membership.organizationId
				? [
						{
							organizationId: membership.organizationId,
							organizationMembershipRoles:
								membership.organizationMembershipRoles.map(
									(membershipRole) => ({
										active: membershipRole.active,
										deletedAt: membershipRole.deletedAt,
										role: {
											active: membershipRole.role.active,
											deletedAt: membershipRole.role.deletedAt,
											name: membershipRole.role.name,
										},
									}),
								),
						},
					]
				: [],
		)
	},

	async loadBulkPurchasesForOrganizations(organizationIds) {
		if (organizationIds.length === 0) return []

		const { db } = await import('@/db')
		const rows = await db.query.purchases.findMany({
			where: and(
				inArray(purchases.organizationId, organizationIds),
				isNotNull(purchases.bulkCouponId),
				inArray(purchases.status, Array.from(VISIBLE_PURCHASE_STATES)),
			),
			with: {
				user: true,
				product: true,
				bulkCoupon: true,
			},
			orderBy: asc(purchases.createdAt),
		})

		return purchaseSchema.array().parse(rows)
	},

	async loadBulkPurchasesOwnedByUser(userId) {
		const { db } = await import('@/db')
		const rows = await db.query.purchases.findMany({
			where: and(
				eq(purchases.userId, userId),
				isNotNull(purchases.bulkCouponId),
				inArray(purchases.status, Array.from(VISIBLE_PURCHASE_STATES)),
			),
			with: {
				user: true,
				product: true,
				bulkCoupon: true,
			},
			orderBy: asc(purchases.createdAt),
		})

		return purchaseSchema.array().parse(rows)
	},
}
