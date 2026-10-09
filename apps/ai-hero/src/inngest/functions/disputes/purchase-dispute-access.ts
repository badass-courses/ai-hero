import {
	PURCHASE_DISPUTE_CLOSED_EVENT,
	PURCHASE_DISPUTE_OPENED_EVENT,
} from '@/inngest/events/purchase-dispute'
import {
	USER_ADDED_TO_COHORT_EVENT,
	USER_ADDED_TO_WORKSHOP_EVENT,
} from '@/inngest/functions/discord/add-discord-role-workflow'
import { inngest } from '@/inngest/inngest.server'
import { removeDiscordRole } from '@/lib/discord-utils'
import {
	applyLostDispute,
	restoreDisputedPurchaseAccess,
	revokeDisputedPurchaseAccess,
	type DisputeRevocation,
} from '@/lib/purchase-disputes'
import { log } from '@/server/logger'

function discordRoleRemoval(revocation: DisputeRevocation) {
	if (
		(revocation.kind === 'revoked' || revocation.kind === 'already-revoked') &&
		revocation.userId
	)
		return { userId: revocation.userId, roles: revocation.discordRoles }
	return { userId: null, roles: [] }
}

/** Throw so Inngest retries the step; a skipped removal is not a failure. */
async function removeRoleOrThrow(userId: string, discordRoleId: string) {
	const result = await removeDiscordRole(userId, discordRoleId)
	if (result.status === 'error')
		throw new Error(`discord role removal failed: ${result.reason}`)
	return result
}

async function logRevocation(revocation: DisputeRevocation) {
	if (revocation.kind === 'revoked' && revocation.isBulk) {
		// Seat holders keep their own seat purchases; an operator decides.
		await log.warn('purchase_dispute.bulk_seats_retained', {
			purchaseId: revocation.purchaseId,
		})
	}
	await log.info('purchase_dispute.access_revoked', {
		purchaseId: revocation.purchaseId,
		result: revocation.kind,
		...(revocation.kind === 'revoked' && {
			previousStatus: revocation.record.previousStatus,
			entitlementsRevoked: revocation.record.revokedEntitlementIds.length,
			discordRoles: revocation.discordRoles.length,
		}),
		...(revocation.kind === 'skipped' && { reason: revocation.reason }),
	})
}

/** An open dispute cuts the purchase's access, the same rows a refund removes. */
export const purchaseDisputeOpened = inngest.createFunction(
	{ id: 'purchase-dispute-opened', name: 'Purchase Dispute Opened' },
	{ event: PURCHASE_DISPUTE_OPENED_EVENT },
	async ({ event, step }) => {
		const revocation: DisputeRevocation = await step.run(
			'revoke disputed purchase access',
			() =>
				revokeDisputedPurchaseAccess({
					purchaseId: event.data.purchaseId,
					stripeDisputeId: event.data.stripeDisputeId,
					previousStatus: event.data.previousStatus,
				}),
		)
		const removal = discordRoleRemoval(revocation)
		for (const role of removal.roles) {
			await step.run(`remove discord role ${role.entitlementId}`, () =>
				removeRoleOrThrow(removal.userId!, role.discordRoleId),
			)
		}
		await logRevocation(revocation)
		return revocation
	},
)

/**
 * Won: restore the recorded status and rows. Lost: keep the cut (revoking now
 * if the open event never arrived) and block the buyer from future checkouts.
 */
export const purchaseDisputeClosed = inngest.createFunction(
	{ id: 'purchase-dispute-closed', name: 'Purchase Dispute Closed' },
	{ event: PURCHASE_DISPUTE_CLOSED_EVENT },
	async ({ event, step }) => {
		const { purchaseId, stripeDisputeId, previousStatus, outcome } = event.data

		if (outcome === 'won') {
			const restoration = await step.run(
				'restore disputed purchase access',
				() => restoreDisputedPurchaseAccess({ purchaseId, stripeDisputeId }),
			)
			if (restoration.kind === 'restored' && restoration.userId) {
				for (const role of restoration.discordRoles) {
					await step.sendEvent(
						`restore discord role ${role.entitlementId}`,
						role.kind === 'cohort'
							? {
									name: USER_ADDED_TO_COHORT_EVENT,
									data: {
										cohortId: purchaseId,
										userId: restoration.userId,
										discordRoleId: role.discordRoleId,
									},
								}
							: {
									name: USER_ADDED_TO_WORKSHOP_EVENT,
									data: {
										workshopId: purchaseId,
										userId: restoration.userId,
										discordRoleId: role.discordRoleId,
									},
								},
					)
				}
			}
			await log.info('purchase_dispute.access_restored', {
				purchaseId,
				result: restoration.kind,
				...(restoration.kind === 'restored' && {
					restoredStatus: restoration.record.previousStatus,
					entitlementsRestored: restoration.restoredEntitlementIds.length,
				}),
				...(restoration.kind === 'skipped' && { reason: restoration.reason }),
			})
			return restoration
		}

		const loss = await step.run('apply lost dispute', () =>
			applyLostDispute({ purchaseId, stripeDisputeId, previousStatus }),
		)
		if (loss.kind === 'blocked') {
			const revocation = loss.revocation as DisputeRevocation
			for (const role of discordRoleRemoval(revocation).roles) {
				await step.run(`remove discord role ${role.entitlementId}`, () =>
					removeRoleOrThrow(loss.userId, role.discordRoleId),
				)
			}
			await logRevocation(revocation)
		}
		await log.info('purchase_dispute.buyer_blocked', {
			purchaseId,
			result: loss.kind,
			...(loss.kind === 'blocked' && { alreadyBlocked: loss.alreadyBlocked }),
			...(loss.kind === 'skipped' && { reason: loss.reason }),
		})
		return loss
	},
)
