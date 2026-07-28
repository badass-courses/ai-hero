import { describe, expect, it, vi } from 'vitest'

import {
	acceptBillingAdminInvitations,
	createBillingAdminInvitationToken,
	inviteBillingAdmin,
	parseBillingAdminInvitationToken,
	removeBillingAdmin,
	revokeBillingAdminInvitation,
	type BillingAdminInvitation,
	type TeamManagerInvitationDataSource,
	type TeamManagerMembership,
} from './team-manager-invitations'

const organizationId = 'org-a'
const owner: TeamManagerMembership = {
	id: 'membership-owner',
	organizationId,
	userId: 'user-owner',
	email: 'owner@example.com',
	name: 'Owner',
	roles: ['owner', 'billing_admin'],
}
const billingAdmin: TeamManagerMembership = {
	id: 'membership-admin',
	organizationId,
	userId: 'user-admin',
	email: 'admin@example.com',
	name: 'Admin',
	roles: ['billing_admin'],
}
const learner: TeamManagerMembership = {
	id: 'membership-learner',
	organizationId,
	userId: 'user-learner',
	email: 'learner@example.com',
	name: 'Learner',
	roles: ['learner'],
}

function createDataSource(overrides: {
	memberships?: TeamManagerMembership[]
	invitations?: BillingAdminInvitation[]
} = {}): TeamManagerInvitationDataSource & {
	invitations: BillingAdminInvitation[]
	memberships: TeamManagerMembership[]
} {
	const memberships = (overrides.memberships ?? [owner, billingAdmin, learner]).map(
		(membership) => ({ ...membership, roles: [...membership.roles] }),
	)
	const invitations = (overrides.invitations ?? []).map((invitation) => ({
		...invitation,
	}))

	return {
		memberships,
		invitations,
		loadMembership: vi.fn(async (userId, targetOrganizationId) =>
			memberships.find(
				(membership) =>
					membership.userId === userId &&
					membership.organizationId === targetOrganizationId,
			),
		),
		loadMembershipById: vi.fn(async (membershipId) =>
			memberships.find((membership) => membership.id === membershipId),
		),
		findManagerByEmail: vi.fn(async (targetOrganizationId, email) =>
			memberships.find(
				(membership) =>
					membership.organizationId === targetOrganizationId &&
					membership.email === email &&
					membership.roles.some((role) =>
						['owner', 'billing_admin'].includes(role),
					),
			),
		),
		upsertPendingInvitation: vi.fn(async (input) => {
			const existing = invitations.find(
				(invitation) =>
					invitation.organizationId === input.organizationId &&
					invitation.email === input.email,
			)
			if (existing) {
				Object.assign(existing, {
					acceptedAt: null,
					acceptedByUserId: null,
					revokedAt: null,
					invitedByUserId: input.invitedByUserId,
				})
				return existing
			}
			const invitation: BillingAdminInvitation = {
				id: `invitation-${invitations.length + 1}`,
				organizationId: input.organizationId,
				organizationName: 'Synthetic Org',
				email: input.email,
				role: 'billing_admin',
				invitedByUserId: input.invitedByUserId,
				acceptedByUserId: null,
				acceptedAt: null,
				revokedAt: null,
				createdAt: new Date('2026-07-17T00:00:00Z'),
			}
			invitations.push(invitation)
			return invitation
		}),
		sendInvitationEmail: vi.fn(async () => undefined),
		loadPendingInvitationsForEmail: vi.fn(async (email) =>
			invitations.filter(
				(invitation) =>
					invitation.email === email &&
					!invitation.acceptedAt &&
					!invitation.revokedAt,
			),
		),
		ensureMembership: vi.fn(async ({ organizationId, userId, email }) => {
			const existing = memberships.find(
				(membership) =>
					membership.organizationId === organizationId &&
					membership.userId === userId,
			)
			if (existing) return existing
			const membership: TeamManagerMembership = {
				id: `membership-${memberships.length + 1}`,
				organizationId,
				userId,
				email,
				name: null,
				roles: [],
			}
			memberships.push(membership)
			return membership
		}),
		ensureBillingAdminRole: vi.fn(async (membership) => {
			if (!membership.roles.includes('billing_admin')) {
				membership.roles.push('billing_admin')
			}
		}),
		markInvitationAccepted: vi.fn(async (invitationId, userId) => {
			const invitation = invitations.find(
				(candidate) => candidate.id === invitationId,
			)
			if (invitation) {
				invitation.acceptedAt = new Date('2026-07-17T01:00:00Z')
				invitation.acceptedByUserId = userId
			}
		}),
		revokeInvitation: vi.fn(async (invitationId, targetOrganizationId) => {
			const invitation = invitations.find(
				(candidate) =>
					candidate.id === invitationId &&
					candidate.organizationId === targetOrganizationId,
			)
			if (!invitation || invitation.acceptedAt || invitation.revokedAt) return false
			invitation.revokedAt = new Date('2026-07-17T01:00:00Z')
			return true
		}),
		removeBillingAdminRole: vi.fn(async (targetOrganizationId, membershipId) => {
			const membership = memberships.find(
				(candidate) =>
					candidate.organizationId === targetOrganizationId &&
					candidate.id === membershipId,
			)
			if (!membership) return false
			membership.roles = membership.roles.filter(
				(role) => role !== 'billing_admin',
			)
			return true
		}),
	}
}

describe('billing admin invitations', () => {
	it('creates recipient-specific durable invitation tokens', () => {
		const first = createBillingAdminInvitationToken({
			organizationId,
			invitedByUserId: owner.userId,
			email: 'first@example.com',
		})
		const second = createBillingAdminInvitationToken({
			organizationId,
			invitedByUserId: owner.userId,
			email: 'second@example.com',
		})

		expect(first).not.toBe(second)
		expect(parseBillingAdminInvitationToken(first)).toMatchObject({
			organizationId,
			invitedByUserId: owner.userId,
		})
	})

	it('rejects a seat learner inviting a manager', async () => {
		const dataSource = createDataSource()

		await expect(
			inviteBillingAdmin(
				{
					actorUserId: learner.userId,
					organizationId,
					email: 'new-manager@example.com',
				},
				dataSource,
			),
		).rejects.toMatchObject({ code: 'forbidden' })
		expect(dataSource.sendInvitationEmail).not.toHaveBeenCalled()
	})

	it('normalizes email and upserts one pending invite on re-invite', async () => {
		const dataSource = createDataSource()
		const input = {
			actorUserId: owner.userId,
			organizationId,
			email: '  NEW.Manager@Example.COM ',
		}

		const first = await inviteBillingAdmin(input, dataSource)
		const second = await inviteBillingAdmin(input, dataSource)

		expect(first.invitation.id).toBe(second.invitation.id)
		expect(dataSource.invitations).toHaveLength(1)
		expect(dataSource.invitations[0]?.email).toBe('new.manager@example.com')
		expect(dataSource.sendInvitationEmail).toHaveBeenCalledTimes(2)
	})

	it('does not invite someone who already manages the organization', async () => {
		const dataSource = createDataSource()

		await expect(
			inviteBillingAdmin(
				{
					actorUserId: owner.userId,
					organizationId,
					email: billingAdmin.email,
				},
				dataSource,
			),
		).rejects.toMatchObject({ code: 'already-manager' })
	})

	it('attaches pending roles at sign-in and ignores revoked invites', async () => {
		const dataSource = createDataSource({
			memberships: [owner],
			invitations: [
				{
					id: 'pending',
					organizationId,
					organizationName: 'Synthetic Org',
					email: 'invitee@example.com',
					role: 'billing_admin',
					invitedByUserId: owner.userId,
					acceptedByUserId: null,
					acceptedAt: null,
					revokedAt: null,
					createdAt: new Date('2026-07-17T00:00:00Z'),
				},
				{
					id: 'revoked',
					organizationId: 'org-b',
					organizationName: 'Revoked Org',
					email: 'invitee@example.com',
					role: 'billing_admin',
					invitedByUserId: 'user-b',
					acceptedByUserId: null,
					acceptedAt: null,
					revokedAt: new Date('2026-07-17T00:30:00Z'),
					createdAt: new Date('2026-07-17T00:00:00Z'),
				},
			],
		})

		const result = await acceptBillingAdminInvitations(
			{ userId: 'user-invitee', email: 'Invitee@Example.com' },
			dataSource,
		)

		expect(result.acceptedOrganizationIds).toEqual([organizationId])
		expect(
			dataSource.memberships.find(
				(membership) => membership.userId === 'user-invitee',
			)?.roles,
		).toContain('billing_admin')
		expect(dataSource.invitations.find(({ id }) => id === 'pending')?.acceptedAt)
			.toBeInstanceOf(Date)
		expect(dataSource.invitations.find(({ id }) => id === 'revoked')?.acceptedAt)
			.toBeNull()
	})

	it('allows a manager to revoke a pending invitation', async () => {
		const dataSource = createDataSource()
		const { invitation } = await inviteBillingAdmin(
			{
				actorUserId: billingAdmin.userId,
				organizationId,
				email: 'pending@example.com',
			},
			dataSource,
		)

		await revokeBillingAdminInvitation(
			{
				actorUserId: billingAdmin.userId,
				organizationId,
				invitationId: invitation.id,
			},
			dataSource,
		)

		expect(invitation.revokedAt).toBeInstanceOf(Date)
	})

	it('removes only the selected billing-admin membership role', async () => {
		const secondAdmin: TeamManagerMembership = {
			...billingAdmin,
			id: 'membership-admin-2',
			userId: 'user-admin-2',
			email: 'admin-2@example.com',
			roles: ['billing_admin'],
		}
		const dataSource = createDataSource({
			memberships: [owner, billingAdmin, secondAdmin],
		})

		await removeBillingAdmin(
			{
				actorUserId: owner.userId,
				organizationId,
				targetMembershipId: billingAdmin.id,
			},
			dataSource,
		)

		expect(
			dataSource.memberships.find(
				(membership) => membership.id === billingAdmin.id,
			)?.roles,
		).not.toContain('billing_admin')
		expect(
			dataSource.memberships.find(
				(membership) => membership.id === secondAdmin.id,
			)?.roles,
		).toContain('billing_admin')
		expect(dataSource.removeBillingAdminRole).toHaveBeenCalledWith(
			organizationId,
			billingAdmin.id,
		)
	})

	it('never lets an admin remove the organization owner', async () => {
		const dataSource = createDataSource()

		await expect(
			removeBillingAdmin(
				{
					actorUserId: billingAdmin.userId,
					organizationId,
					targetMembershipId: owner.id,
				},
				dataSource,
			),
		).rejects.toMatchObject({ code: 'owner-protected' })
		expect(dataSource.removeBillingAdminRole).not.toHaveBeenCalled()
	})
})
