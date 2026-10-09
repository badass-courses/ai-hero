import {
	PURCHASE_DISPUTE_CLOSED_EVENT,
	PURCHASE_DISPUTE_OPENED_EVENT,
} from '@/inngest/events/purchase-dispute'
import { inngest } from '@/inngest/inngest.server'
import { discordRoleClient } from '@/lib/discord-utils'
import {
	applyDisputeEvent,
	syncDisputeDiscordRole,
	type DiscordRoleSync,
	type DisputeResult,
} from '@/lib/purchase-disputes'
import { log } from '@/server/logger'

type Step = {
	run: (id: string, work: () => Promise<unknown>) => Promise<unknown>
	sleep: (id: string, duration: string) => Promise<unknown>
}

/**
 * Each role is its own step and reads the database when it runs, so a step
 * retried after a later win or loss acts on the current state, not on the
 * role list this run cached. A change Discord accepted but whose readback
 * failed is verified again after a pause; that step throws, and so retries,
 * until Discord confirms it.
 */
async function syncDiscordRoles(
	step: Step,
	result: DisputeResult,
	stripeDisputeId: string,
	prefix = 'sync',
) {
	if (!('record' in result) || !result.record) return []
	const sync = (discordRoleId: string) =>
		syncDisputeDiscordRole({
			purchaseId: result.purchaseId,
			stripeDisputeId,
			discordRoleId,
			discord: discordRoleClient,
		})
	const synced = []
	for (const discordRoleId of result.record.discordRoleIds) {
		const outcome = (await step.run(
			`${prefix} discord role ${discordRoleId}`,
			() => sync(discordRoleId),
		)) as DiscordRoleSync
		if (outcome.kind === 'synced' && !outcome.verified) {
			await step.sleep(`${prefix} discord role ${discordRoleId} settle`, '2m')
			await step.run(
				`${prefix} verify discord role ${discordRoleId}`,
				async () => {
					const verified = await sync(discordRoleId)
					if (verified.kind === 'synced' && !verified.verified)
						throw new Error(`discord role ${discordRoleId} still unverified`)
					return verified
				},
			)
		}
		synced.push(outcome)
	}
	return synced
}

async function logResult(event: string, result: DisputeResult) {
	const applied =
		result.kind === 'applied' ||
		result.kind === 'repaired' ||
		result.kind === 'unchanged'
	if (applied && result.isBulk && result.from === null) {
		// Seat holders keep their own seat purchases; an operator decides.
		await log.warn('purchase_dispute.bulk_seats_retained', {
			purchaseId: result.purchaseId,
		})
	}
	if (applied && result.restoreHeld) {
		await log.warn('purchase_dispute.restore_held', {
			purchaseId: result.purchaseId,
			reason: result.restoreHeld,
		})
	}
	if (applied && result.statusHeld) {
		await log.warn('purchase_dispute.status_held', {
			purchaseId: result.purchaseId,
			reason: result.statusHeld,
		})
	}
	if (result.buyerOutcome?.status === 'held') {
		await log.warn('purchase_dispute.buyer_block_held', {
			purchaseId: result.purchaseId,
			reason: result.buyerOutcome.reason,
		})
	}
	await log.info(`purchase_dispute.${event}`, {
		purchaseId: result.purchaseId,
		result: result.kind,
		...('reason' in result && result.reason && { reason: result.reason }),
		...(applied && {
			from: result.from,
			to: result.to,
			status: result.status,
			plannedStatus: result.plannedStatus,
			entitlementsCut:
				result.cutEntitlementIds.length + result.cutCreditEntitlementIds.length,
			entitlementsRestored: result.restoreEntitlementIds.length,
		}),
		...(result.buyerOutcome && { buyer: result.buyerOutcome.status }),
	})
}

/** An open dispute cuts the purchase's access, the same rows a refund removes. */
export const purchaseDisputeOpened = inngest.createFunction(
	{ id: 'purchase-dispute-opened', name: 'Purchase Dispute Opened' },
	{ event: PURCHASE_DISPUTE_OPENED_EVENT },
	async ({ event, step }) => {
		const { purchaseId, stripeDisputeId, previousStatus } = event.data
		const result: DisputeResult = await step.run('apply dispute opened', () =>
			applyDisputeEvent({
				purchaseId,
				stripeDisputeId,
				previousStatus,
				event: 'opened',
			}),
		)
		const discord = await syncDiscordRoles(step, result, stripeDisputeId)
		await logResult('opened', result)
		return { result, discord }
	},
)

/**
 * Won: restore what the cut recorded. Lost: keep the cut (cutting now if the
 * open event never arrived) and block the paying buyer. Either way, check
 * again after racing status writes have landed and repair the status.
 */
export const purchaseDisputeClosed = inngest.createFunction(
	{ id: 'purchase-dispute-closed', name: 'Purchase Dispute Closed' },
	{ event: PURCHASE_DISPUTE_CLOSED_EVENT },
	async ({ event, step }) => {
		const { purchaseId, stripeDisputeId, previousStatus, outcome } = event.data
		const result: DisputeResult = await step.run(
			`apply dispute ${outcome}`,
			() =>
				applyDisputeEvent({
					purchaseId,
					stripeDisputeId,
					previousStatus,
					event: outcome,
				}),
		)
		const discord = await syncDiscordRoles(step, result, stripeDisputeId)
		await logResult(outcome, result)

		if (result.kind === 'purchase-not-found' || result.kind === 'ignored')
			return { result, discord }

		await step.sleep('let racing status writes land', '15m')
		const reconciled: DisputeResult = await step.run('reconcile dispute', () =>
			applyDisputeEvent({ purchaseId, stripeDisputeId, event: 'reconcile' }),
		)
		if (reconciled.kind !== 'unchanged')
			await logResult('reconciled', reconciled)
		const reconciledDiscord = await syncDiscordRoles(
			step,
			reconciled,
			stripeDisputeId,
			'reconcile',
		)
		return { result, discord, reconciled, reconciledDiscord }
	},
)
