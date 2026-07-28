import { createHash } from 'node:crypto'

import {
	BILLING_ADMIN_ROLE,
	isTeamPurchaseManagerRole,
} from '@/lib/team-roles'
import { z } from 'zod'

export type TeamManagerMembership = {
	id: string
	organizationId: string
	userId: string
	email: string
	name: string | null
	roles: string[]
}

export type BillingAdminInvitation = {
	id: string
	organizationId: string
	organizationName: string
	email: string
	role: typeof BILLING_ADMIN_ROLE
	invitedByUserId: string
	acceptedByUserId: string | null
	acceptedAt: Date | null
	revokedAt: Date | null
	createdAt: Date
}

export type TeamManagerInvitationDataSource = {
	loadMembership(
		userId: string,
		organizationId: string,
	): Promise<TeamManagerMembership | undefined>
	loadMembershipById(
		membershipId: string,
	): Promise<TeamManagerMembership | undefined>
	findManagerByEmail(
		organizationId: string,
		email: string,
	): Promise<TeamManagerMembership | undefined>
	upsertPendingInvitation(input: {
		organizationId: string
		email: string
		invitedByUserId: string
	}): Promise<BillingAdminInvitation>
	sendInvitationEmail(invitation: BillingAdminInvitation): Promise<void>
	loadPendingInvitationsForEmail(
		email: string,
	): Promise<BillingAdminInvitation[]>
	ensureMembership(input: {
		organizationId: string
		userId: string
		email: string
		invitedByUserId: string
	}): Promise<TeamManagerMembership>
	ensureBillingAdminRole(membership: TeamManagerMembership): Promise<void>
	markInvitationAccepted(invitationId: string, userId: string): Promise<void>
	revokeInvitation(
		invitationId: string,
		organizationId: string,
	): Promise<boolean>
	removeBillingAdminRole(
		organizationId: string,
		membershipId: string,
	): Promise<boolean>
}

export type TeamManagerErrorCode =
	| 'already-manager'
	| 'forbidden'
	| 'invalid-email'
	| 'invitation-not-found'
	| 'member-not-found'
	| 'owner-protected'

export class TeamManagerError extends Error {
	constructor(
		public readonly code: TeamManagerErrorCode,
		message: string,
	) {
		super(message)
		this.name = 'TeamManagerError'
	}
}

const emailSchema = z.string().trim().toLowerCase().email().max(255)
const INVITATION_TOKEN_PREFIX = 'billing_admin:'

export function createBillingAdminInvitationToken(input: {
	organizationId: string
	invitedByUserId: string
	email: string
}): string {
	if (input.organizationId.includes(':') || input.invitedByUserId.includes(':')) {
		throw new Error('Billing admin invitation IDs cannot contain colons')
	}
	const emailFingerprint = createHash('sha256')
		.update(input.email)
		.digest('hex')
		.slice(0, 16)
	const token = `${INVITATION_TOKEN_PREFIX}${input.organizationId}:${input.invitedByUserId}:${emailFingerprint}`
	if (token.length > 255) throw new Error('Billing admin invitation token is too long')
	return token
}

export function parseBillingAdminInvitationToken(
	token: string,
): {
	organizationId: string
	invitedByUserId: string
	emailFingerprint: string
} | null {
	if (!token.startsWith(INVITATION_TOKEN_PREFIX)) return null
	const [organizationId, invitedByUserId, emailFingerprint, extra] = token
		.slice(INVITATION_TOKEN_PREFIX.length)
		.split(':')
	if (!organizationId || !invitedByUserId || !emailFingerprint || extra) {
		return null
	}
	return { organizationId, invitedByUserId, emailFingerprint }
}

export function normalizeTeamManagerEmail(email: string): string {
	const parsed = emailSchema.safeParse(email)
	if (!parsed.success) {
		throw new TeamManagerError('invalid-email', 'Enter a valid email address.')
	}
	return parsed.data
}

function canManageTeam(membership: TeamManagerMembership | undefined): boolean {
	return Boolean(
		membership?.roles.some((role) => isTeamPurchaseManagerRole(role)),
	)
}

async function requireManager(
	actorUserId: string,
	organizationId: string,
	dataSource: TeamManagerInvitationDataSource,
): Promise<TeamManagerMembership> {
	const actor = await dataSource.loadMembership(actorUserId, organizationId)
	if (!actor || !canManageTeam(actor)) {
		throw new TeamManagerError(
			'forbidden',
			'You do not have permission to manage this team.',
		)
	}
	return actor
}

async function getDataSource(
	dataSource?: TeamManagerInvitationDataSource,
): Promise<TeamManagerInvitationDataSource> {
	if (dataSource) return dataSource
	const { drizzleTeamManagerInvitationDataSource } = await import(
		'@/lib/team-manager-invitations-drizzle'
	)
	return drizzleTeamManagerInvitationDataSource
}

export async function inviteBillingAdmin(
	input: {
		actorUserId: string
		organizationId: string
		email: string
	},
	providedDataSource?: TeamManagerInvitationDataSource,
): Promise<{ invitation: BillingAdminInvitation }> {
	const dataSource = await getDataSource(providedDataSource)
	await requireManager(
		input.actorUserId,
		input.organizationId,
		dataSource,
	)
	const email = normalizeTeamManagerEmail(input.email)
	const existingManager = await dataSource.findManagerByEmail(
		input.organizationId,
		email,
	)
	if (existingManager) {
		throw new TeamManagerError(
			'already-manager',
			'This person already manages the team.',
		)
	}

	const invitation = await dataSource.upsertPendingInvitation({
		organizationId: input.organizationId,
		email,
		invitedByUserId: input.actorUserId,
	})
	await dataSource.sendInvitationEmail(invitation)
	return { invitation }
}

export async function acceptBillingAdminInvitations(
	input: { userId: string; email: string },
	providedDataSource?: TeamManagerInvitationDataSource,
): Promise<{ acceptedOrganizationIds: string[] }> {
	const dataSource = await getDataSource(providedDataSource)
	const email = normalizeTeamManagerEmail(input.email)
	const invitations = await dataSource.loadPendingInvitationsForEmail(email)
	const acceptedOrganizationIds = new Set<string>()

	for (const invitation of invitations) {
		if (invitation.role !== BILLING_ADMIN_ROLE) continue
		const membership = await dataSource.ensureMembership({
			organizationId: invitation.organizationId,
			userId: input.userId,
			email,
			invitedByUserId: invitation.invitedByUserId,
		})
		await dataSource.ensureBillingAdminRole(membership)
		await dataSource.markInvitationAccepted(invitation.id, input.userId)
		acceptedOrganizationIds.add(invitation.organizationId)
	}

	return { acceptedOrganizationIds: Array.from(acceptedOrganizationIds) }
}

export async function revokeBillingAdminInvitation(
	input: {
		actorUserId: string
		organizationId: string
		invitationId: string
	},
	providedDataSource?: TeamManagerInvitationDataSource,
): Promise<void> {
	const dataSource = await getDataSource(providedDataSource)
	await requireManager(
		input.actorUserId,
		input.organizationId,
		dataSource,
	)
	const revoked = await dataSource.revokeInvitation(
		input.invitationId,
		input.organizationId,
	)
	if (!revoked) {
		throw new TeamManagerError(
			'invitation-not-found',
			'This pending invitation is no longer available.',
		)
	}
}

export async function removeBillingAdmin(
	input: {
		actorUserId: string
		organizationId: string
		targetMembershipId: string
	},
	providedDataSource?: TeamManagerInvitationDataSource,
): Promise<void> {
	const dataSource = await getDataSource(providedDataSource)
	await requireManager(
		input.actorUserId,
		input.organizationId,
		dataSource,
	)
	const target = await dataSource.loadMembershipById(input.targetMembershipId)
	if (!target || target.organizationId !== input.organizationId) {
		throw new TeamManagerError(
			'member-not-found',
			'This team manager was not found.',
		)
	}
	if (target.roles.includes('owner')) {
		throw new TeamManagerError(
			'owner-protected',
			'The team owner cannot be removed.',
		)
	}
	if (!target.roles.includes(BILLING_ADMIN_ROLE)) {
		throw new TeamManagerError(
			'member-not-found',
			'This team manager was not found.',
		)
	}

	const removed = await dataSource.removeBillingAdminRole(
		input.organizationId,
		input.targetMembershipId,
	)
	if (!removed) {
		throw new TeamManagerError(
			'member-not-found',
			'This team manager was not found.',
		)
	}
}
