'use server'

import { revalidatePath } from 'next/cache'
import {
	inviteBillingAdmin,
	removeBillingAdmin,
	revokeBillingAdminInvitation,
	TeamManagerError,
} from '@/lib/team-manager-invitations'
import { getServerAuthSession } from '@/server/auth'
import { log } from '@/server/logger'
import { z } from 'zod'

export type TeamManagerActionState = {
	status: 'idle' | 'success' | 'error'
	message: string
}

const organizationInput = z.object({
	organizationId: z.string().min(1),
})

async function requireUserId(): Promise<string> {
	const { session } = await getServerAuthSession()
	if (!session?.user?.id) throw new TeamManagerError('forbidden', 'Sign in first.')
	return session.user.id
}

function actionError(error: unknown): TeamManagerActionState {
	if (error instanceof TeamManagerError) {
		return { status: 'error', message: error.message }
	}
	return {
		status: 'error',
		message: 'Something went wrong. Please try again or contact support.',
	}
}

export async function inviteBillingAdminAction(
	_previousState: TeamManagerActionState,
	formData: FormData,
): Promise<TeamManagerActionState> {
	try {
		const actorUserId = await requireUserId()
		const input = organizationInput
			.extend({ email: z.string().min(1) })
			.parse(Object.fromEntries(formData))
		await inviteBillingAdmin({ actorUserId, ...input })
		await log.info('team.billing-admin.invited', {
			actorUserId,
			organizationId: input.organizationId,
		})
		revalidatePath('/team')
		return {
			status: 'success',
			message: 'Invitation sent. The role attaches when they sign in.',
		}
	} catch (error) {
		await log.error('team.billing-admin.invite-failed', {
			error: error instanceof Error ? error.message : String(error),
		})
		return actionError(error)
	}
}

export async function removeBillingAdminAction(
	_previousState: TeamManagerActionState,
	formData: FormData,
): Promise<TeamManagerActionState> {
	try {
		const actorUserId = await requireUserId()
		const input = organizationInput
			.extend({ targetMembershipId: z.string().min(1) })
			.parse(Object.fromEntries(formData))
		await removeBillingAdmin({ actorUserId, ...input })
		await log.info('team.billing-admin.removed', {
			actorUserId,
			organizationId: input.organizationId,
		})
		revalidatePath('/team')
		return { status: 'success', message: 'Manager access removed.' }
	} catch (error) {
		await log.error('team.billing-admin.remove-failed', {
			error: error instanceof Error ? error.message : String(error),
		})
		return actionError(error)
	}
}

export async function revokeBillingAdminInvitationAction(
	_previousState: TeamManagerActionState,
	formData: FormData,
): Promise<TeamManagerActionState> {
	try {
		const actorUserId = await requireUserId()
		const input = organizationInput
			.extend({ invitationId: z.string().min(1) })
			.parse(Object.fromEntries(formData))
		await revokeBillingAdminInvitation({ actorUserId, ...input })
		await log.info('team.billing-admin.invitation-revoked', {
			actorUserId,
			organizationId: input.organizationId,
		})
		revalidatePath('/team')
		return { status: 'success', message: 'Pending invitation revoked.' }
	} catch (error) {
		await log.error('team.billing-admin.invitation-revoke-failed', {
			error: error instanceof Error ? error.message : String(error),
		})
		return actionError(error)
	}
}
