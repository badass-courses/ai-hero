import {
	organization,
	organizationMemberships,
	verificationTokens,
} from '@/db/schema'
import { parseBillingAdminInvitationToken } from '@/lib/team-manager-invitations'
import { getManagedOrganizationIds } from '@/lib/team-purchases'
import { isTeamPurchaseManagerRole } from '@/lib/team-roles'
import { and, asc, eq, gt, inArray, like, or } from 'drizzle-orm'

import type { TeamPurchaseMembership } from '@/lib/team-purchases'

export type TeamManagerOrganization = {
	id: string
	name: string
	managers: {
		membershipId: string
		userId: string
		name: string | null
		email: string
		role: 'owner' | 'billing_admin'
	}[]
	pendingInvitations: {
		id: string
		email: string
		createdAt: string
	}[]
}

export type TeamManagerDirectoryDataSource = {
	loadMembershipsForUser(userId: string): Promise<TeamPurchaseMembership[]>
	loadOrganizationsForIds(
		organizationIds: string[],
	): Promise<TeamManagerOrganization[]>
}

export async function getTeamManagerOrganizationsForMember(
	userId: string | null | undefined,
	dataSource: TeamManagerDirectoryDataSource = drizzleTeamManagerDirectoryDataSource,
): Promise<TeamManagerOrganization[]> {
	if (!userId) return []
	const memberships = await dataSource.loadMembershipsForUser(userId)
	const organizationIds = getManagedOrganizationIds(memberships)
	if (organizationIds.length === 0) return []

	const authorizedIds = new Set(organizationIds)
	const organizations = await dataSource.loadOrganizationsForIds(organizationIds)
	return organizations.filter(({ id }) => authorizedIds.has(id))
}

export const drizzleTeamManagerDirectoryDataSource: TeamManagerDirectoryDataSource =
	{
		async loadMembershipsForUser(userId) {
			const { db } = await import('@/db')
			const rows = await db.query.organizationMemberships.findMany({
				where: eq(organizationMemberships.userId, userId),
				with: {
					organizationMembershipRoles: { with: { role: true } },
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

		async loadOrganizationsForIds(organizationIds) {
			if (organizationIds.length === 0) return []
			const { db } = await import('@/db')
			const [organizationRows, membershipRows, invitationRows] =
				await Promise.all([
					db.query.organization.findMany({
						where: inArray(organization.id, organizationIds),
						orderBy: asc(organization.name),
					}),
					db.query.organizationMemberships.findMany({
						where: inArray(
							organizationMemberships.organizationId,
							organizationIds,
						),
						with: {
							user: true,
							organizationMembershipRoles: { with: { role: true } },
						},
					}),
					db.query.verificationTokens.findMany({
						where: and(
							or(
								...organizationIds.map((organizationId) =>
									like(
										verificationTokens.token,
										`billing_admin:${organizationId}:%`,
									),
								),
							),
							gt(verificationTokens.expires, new Date()),
						),
						orderBy: asc(verificationTokens.createdAt),
					}),
				])

			return organizationRows.map((targetOrganization) => ({
				id: targetOrganization.id,
				name: targetOrganization.name ?? 'Team organization',
				managers: membershipRows.flatMap((membership) => {
					if (
						membership.organizationId !== targetOrganization.id ||
						!membership.user
					) {
						return []
					}
					const activeRoles = membership.organizationMembershipRoles.flatMap(
						(membershipRole) =>
							membershipRole.active &&
							!membershipRole.deletedAt &&
							membershipRole.role.active &&
							!membershipRole.role.deletedAt &&
							isTeamPurchaseManagerRole(membershipRole.role.name)
								? [membershipRole.role.name]
								: [],
					)
					if (activeRoles.length === 0) return []
					return [
						{
							membershipId: membership.id,
							userId: membership.user.id,
							name: membership.user.name,
							email: membership.user.email,
							role: activeRoles.includes('owner')
								? ('owner' as const)
								: ('billing_admin' as const),
						},
					]
				}),
				pendingInvitations: invitationRows.flatMap((invitation) => {
					const parsed = parseBillingAdminInvitationToken(invitation.token)
					return parsed?.organizationId === targetOrganization.id
						? [
								{
									id: invitation.token,
									email: invitation.identifier,
									createdAt: (
										invitation.createdAt ?? new Date()
									).toISOString(),
								},
							]
						: []
				}),
			}))
		},
	}
