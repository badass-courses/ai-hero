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
	purchase: Pick<Purchase, 'id' | 'userId'>,
	managedTeamPurchases: Pick<Purchase, 'id'>[],
): boolean {
	if (!viewerUserId) return false
	return (
		purchase.userId === viewerUserId ||
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
}
