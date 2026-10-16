import { organizationMemberships, purchases } from '@/db/schema'
import {
	canEditInvoice,
	type InvoiceTransferFact,
} from '@/lib/invoice-access-rules'
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

export type TeamPurchaseStatus =
	| 'Valid'
	| 'Refunded'
	| 'Restricted'
	| 'Disputed'
	| 'Banned'

/**
 * How the viewer's own bulk purchase relates to an organization they manage.
 *
 * - `managed`: held by an organization the viewer manages.
 * - `no-organization`: the purchase has no organization. Its coupon still
 *   works, so the invite link and seat list render from the purchase alone,
 *   as `/welcome` already does.
 * - `not-a-manager`: the purchase is held by an organization the viewer
 *   belongs to without a manager role (they handed management off).
 * - `no-membership`: the purchase names an organization the viewer is not a
 *   member of. Nothing would render, so the page says it is being set up.
 */
export type TeamPurchaseLink =
	| 'managed'
	| 'no-organization'
	| 'not-a-manager'
	| 'no-membership'

/**
 * What a team card on `/team` may offer. Seat and invite actions exist only
 * for `active`; every other state names why they are gone.
 */
export type TeamCardState =
	| 'active'
	| 'refunded'
	| 'setting-up'
	| 'managed-by-admin'
	| 'coupon-inactive'
	| 'unavailable'

export function getTeamCardState({
	purchaseStatus,
	link,
	couponActive,
}: {
	purchaseStatus: TeamPurchaseStatus | (string & {})
	link: TeamPurchaseLink
	couponActive: boolean
}): TeamCardState {
	if (purchaseStatus === 'Refunded') return 'refunded'
	if (purchaseStatus !== 'Valid' && purchaseStatus !== 'Restricted')
		return 'unavailable'
	if (link === 'not-a-manager') return 'managed-by-admin'
	if (link === 'no-membership') return 'setting-up'
	return couponActive ? 'active' : 'coupon-inactive'
}

/** Classify a bulk purchase the viewer owns but no managed organization holds. */
export function getTeamPurchaseLink(
	purchase: Pick<Purchase, 'organizationId'>,
	memberships: Pick<TeamPurchaseMembership, 'organizationId'>[],
): Exclude<TeamPurchaseLink, 'managed'> {
	if (!purchase.organizationId) return 'no-organization'
	return memberships.some(
		({ organizationId }) => organizationId === purchase.organizationId,
	)
		? 'not-a-manager'
		: 'no-membership'
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

/**
 * The edit gate for an invoice (the name is historical): the payer, or a
 * manager of the team purchase. A holder who did not pay never edits.
 * `originTransfer` is the earliest completed transfer, which names the payer
 * for purchases transferred before charges stayed with the payer.
 */
export function canViewPurchaseInvoice(
	viewerUserId: string | null | undefined,
	purchase: Pick<Purchase, 'id' | 'userId'> & {
		billingUserId?: string | null
		originTransfer?: InvoiceTransferFact | null
	},
	managedTeamPurchases: Pick<Purchase, 'id'>[],
): boolean {
	if (!viewerUserId) return false
	return (
		canEditInvoice({
			viewerId: viewerUserId,
			payerUserId: purchase.billingUserId ?? purchase.userId,
			holderUserId: purchase.userId,
			transfer: purchase.originTransfer ?? null,
		}) ||
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
): Promise<
	{ purchase: Purchase; link: Exclude<TeamPurchaseLink, 'managed'> }[]
> {
	if (!userId || !dataSource.loadBulkPurchasesOwnedByUser) return []
	const [owned, memberships] = await Promise.all([
		dataSource.loadBulkPurchasesOwnedByUser(userId),
		dataSource.loadMembershipsForUser(userId),
	])
	// The repository query is scoped too; this keeps another user's row out.
	return getUnlinkedBulkPurchases(
		owned.filter((purchase) => purchase.userId === userId),
		managedPurchases,
	).map((purchase) => ({
		purchase,
		link: getTeamPurchaseLink(purchase, memberships),
	}))
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
