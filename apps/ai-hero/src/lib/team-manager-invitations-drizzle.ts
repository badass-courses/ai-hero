import BasicEmail from '@/emails/basic-email'
import { courseBuilderAdapter, db } from '@/db'
import {
	organization,
	organizationMembershipRoles,
	organizationMemberships,
	roles,
	users,
	verificationTokens,
} from '@/db/schema'
import { env } from '@/env.mjs'
import {
	createBillingAdminInvitationToken,
	parseBillingAdminInvitationToken,
	type BillingAdminInvitation,
	type TeamManagerInvitationDataSource,
	type TeamManagerMembership,
} from '@/lib/team-manager-invitations'
import { BILLING_ADMIN_ROLE } from '@/lib/team-roles'
import { and, eq, gt, sql } from 'drizzle-orm'

import { sendAnEmail } from '@coursebuilder/utils/send-an-email'

const INVITATION_TTL_DAYS = 30

function invitationExpiry(): Date {
	return new Date(Date.now() + INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000)
}

async function loadMembershipByWhere(
	where: ReturnType<typeof and>,
): Promise<TeamManagerMembership | undefined> {
	const membership = await db.query.organizationMemberships.findFirst({
		where,
		with: {
			user: true,
			organizationMembershipRoles: { with: { role: true } },
		},
	})
	if (!membership?.organizationId || !membership.user) return undefined

	return {
		id: membership.id,
		organizationId: membership.organizationId,
		userId: membership.user.id,
		email: membership.user.email.toLowerCase(),
		name: membership.user.name,
		roles: membership.organizationMembershipRoles.flatMap((membershipRole) =>
			membershipRole.active &&
			!membershipRole.deletedAt &&
			membershipRole.role.active &&
			!membershipRole.role.deletedAt
				? [membershipRole.role.name]
				: [],
		),
	}
}

async function toInvitation(row: {
	identifier: string
	token: string
	createdAt: Date | null
}): Promise<BillingAdminInvitation> {
	const parsed = parseBillingAdminInvitationToken(row.token)
	if (!parsed) throw new Error('Invalid billing admin invitation token')
	const targetOrganization = await db.query.organization.findFirst({
		where: eq(organization.id, parsed.organizationId),
	})
	if (!targetOrganization) throw new Error('Invitation organization was not found')

	return {
		id: row.token,
		organizationId: parsed.organizationId,
		organizationName: targetOrganization.name ?? 'Team organization',
		email: row.identifier,
		role: BILLING_ADMIN_ROLE,
		invitedByUserId: parsed.invitedByUserId,
		acceptedByUserId: null,
		acceptedAt: null,
		revokedAt: null,
		createdAt: row.createdAt ?? new Date(),
	}
}

export const drizzleTeamManagerInvitationDataSource: TeamManagerInvitationDataSource =
	{
		async loadMembership(userId, organizationId) {
			return loadMembershipByWhere(
				and(
					eq(organizationMemberships.userId, userId),
					eq(organizationMemberships.organizationId, organizationId),
				),
			)
		},

		async loadMembershipById(membershipId) {
			return loadMembershipByWhere(
				and(eq(organizationMemberships.id, membershipId)),
			)
		},

		async findManagerByEmail(organizationId, email) {
			const user = await db.query.users.findFirst({
				where: sql`lower(${users.email}) = ${email}`,
			})
			if (!user) return undefined
			const membership = await this.loadMembership(user.id, organizationId)
			return membership?.roles.some((role) =>
				['owner', BILLING_ADMIN_ROLE].includes(role),
			)
				? membership
				: undefined
		},

		async upsertPendingInvitation(input) {
			const existingRows = await db.query.verificationTokens.findMany({
				where: and(
					eq(verificationTokens.identifier, input.email),
					gt(verificationTokens.expires, new Date()),
				),
			})
			const sameOrganizationRows = existingRows.filter(
				(row) =>
					parseBillingAdminInvitationToken(row.token)?.organizationId ===
					input.organizationId,
			)
			for (const row of sameOrganizationRows) {
				await db
					.delete(verificationTokens)
					.where(
						and(
							eq(verificationTokens.identifier, row.identifier),
							eq(verificationTokens.token, row.token),
						),
					)
			}

			const token = createBillingAdminInvitationToken({
				organizationId: input.organizationId,
				invitedByUserId: input.invitedByUserId,
				email: input.email,
			})
			const expires = invitationExpiry()
			await db
				.insert(verificationTokens)
				.values({
					identifier: input.email,
					token,
					expires,
				})
				.onDuplicateKeyUpdate({ set: { expires } })
			const invitation = await db.query.verificationTokens.findFirst({
				where: and(
					eq(verificationTokens.identifier, input.email),
					eq(verificationTokens.token, token),
				),
			})
			if (!invitation) throw new Error('Invitation upsert failed')
			return toInvitation(invitation)
		},

		async sendInvitationEmail(invitation) {
			const loginUrl = `${env.NEXT_PUBLIC_URL}/login?callbackUrl=${encodeURIComponent('/team')}`
			await sendAnEmail({
				Component: BasicEmail,
				componentProps: {
					body: `You've been invited to manage the **${invitation.organizationName}** team on AI Hero. Team managers can invite learners, see seat usage, and view team invoices.\n\n[Sign in to accept the invitation](${loginUrl})\n\nUse **${invitation.email}** when you sign in. The manager role does not consume a seat.`,
					preview: `Manage ${invitation.organizationName}'s AI Hero team`,
					messageType: 'transactional',
				},
				Subject: `You're invited to manage an AI Hero team`,
				To: invitation.email,
				From: `${env.NEXT_PUBLIC_SITE_TITLE} <${env.NEXT_PUBLIC_SUPPORT_EMAIL}>`,
				type: 'transactional',
			})
		},

		async loadPendingInvitationsForEmail(email) {
			const rows = await db.query.verificationTokens.findMany({
				where: and(
					eq(verificationTokens.identifier, email),
					gt(verificationTokens.expires, new Date()),
				),
			})
			return Promise.all(
				rows
					.filter((row) => parseBillingAdminInvitationToken(row.token))
					.map(toInvitation),
			)
		},

		async ensureMembership(input) {
			const existing = await this.loadMembership(
				input.userId,
				input.organizationId,
			)
			if (existing) return existing

			const membership = await courseBuilderAdapter.addMemberToOrganization({
				organizationId: input.organizationId,
				userId: input.userId,
				invitedById: input.invitedByUserId,
			})
			if (!membership) throw new Error('Unable to create organization membership')
			return {
				id: membership.id,
				organizationId: input.organizationId,
				userId: input.userId,
				email: input.email,
				name: null,
				roles: [],
			}
		},

		async ensureBillingAdminRole(membership) {
			await courseBuilderAdapter.addRoleForMember({
				organizationId: membership.organizationId,
				memberId: membership.id,
				role: BILLING_ADMIN_ROLE,
			})
			const role = await db.query.roles.findFirst({
				where: and(
					eq(roles.organizationId, membership.organizationId),
					eq(roles.name, BILLING_ADMIN_ROLE),
				),
			})
			if (!role) throw new Error('Billing admin role was not created')

			await db
				.update(roles)
				.set({ active: true, deletedAt: null })
				.where(eq(roles.id, role.id))
			await db
				.update(organizationMembershipRoles)
				.set({
					active: true,
					deletedAt: null,
					organizationId: membership.organizationId,
				})
				.where(
					and(
						eq(
							organizationMembershipRoles.organizationMembershipId,
							membership.id,
						),
						eq(organizationMembershipRoles.roleId, role.id),
					),
				)
		},

		async markInvitationAccepted(invitationId) {
			const row = await db.query.verificationTokens.findFirst({
				where: eq(verificationTokens.token, invitationId),
			})
			if (!row) return
			await db
				.delete(verificationTokens)
				.where(
					and(
						eq(verificationTokens.identifier, row.identifier),
						eq(verificationTokens.token, row.token),
					),
				)
		},

		async revokeInvitation(invitationId, organizationId) {
			const parsed = parseBillingAdminInvitationToken(invitationId)
			if (!parsed || parsed.organizationId !== organizationId) return false
			const result = await db
				.delete(verificationTokens)
				.where(eq(verificationTokens.token, invitationId))
			return (result.rowsAffected ?? 0) === 1
		},

		async removeBillingAdminRole(organizationId, membershipId) {
			const role = await db.query.roles.findFirst({
				where: and(
					eq(roles.organizationId, organizationId),
					eq(roles.name, BILLING_ADMIN_ROLE),
				),
			})
			if (!role) return false
			const result = await db
				.update(organizationMembershipRoles)
				.set({ active: false, deletedAt: new Date() })
				.where(
					and(
						eq(
							organizationMembershipRoles.organizationMembershipId,
							membershipId,
						),
						eq(organizationMembershipRoles.organizationId, organizationId),
						eq(organizationMembershipRoles.roleId, role.id),
					),
				)
			return (result.rowsAffected ?? 0) === 1
		},
	}
