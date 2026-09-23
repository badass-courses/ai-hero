import { emailProvider } from '@/coursebuilder/email-provider'
import { courseBuilderAdapter, db } from '@/db'
import { purchaseUserTransfer as transferTable } from '@/db/schema'
import { env } from '@/env.mjs'
import { findOrCreateUserWithPersonalOrg } from '@/lib/find-or-create-user'
import {
	IN_FLIGHT_TRANSFER_STATES,
	isTransferExpired,
} from '@/purchase-transfer/transfer-lifecycle'
import {
	transferEmailHtml,
	transferEmailText,
} from '@/purchase-transfer/transfer-email'
import { authOptions } from '@/server/auth'
import { log } from '@/server/logger'
import { sendServerEmail } from '@coursebuilder/email/send-server-email'
import type { NextAuthConfig } from 'next-auth'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'

/** Support may invite the named recipient, but only that recipient can accept.
 * The existing accept action and Inngest completion gate move ownership and
 * grant access. Never call the adapter's direct transferPurchaseToUser here:
 * it marks the transfer complete without granting the recipient access.
 */
export type SupportTransferPreflight =
	| { state: 'ready'; transferId: string; expiresAt: Date | null; targetEmail: string }
	| {
			state: 'blocked'
			reason:
				| 'invalid_email'
				| 'purchase_missing'
				| 'not_purchase_owner'
				| 'purchase_not_valid'
				| 'same_user'
				| 'transfer_in_flight'
				| 'transfer_slot_missing'
				| 'transfer_slot_expired'
				| 'transfer_race_lost'
		  }

export type SupportTransferInitiation =
	| { state: 'invited'; transferId: string }
	| Extract<SupportTransferPreflight, { state: 'blocked' }>
	| { state: 'delivery_unknown'; transferId: string }

function rowsAffected(result: unknown): number {
	if (result && typeof result === 'object' && 'rowsAffected' in result &&
		typeof result.rowsAffected === 'number') return result.rowsAffected
	if (Array.isArray(result) && result[0] && typeof result[0] === 'object' &&
		'affectedRows' in result[0] && typeof result[0].affectedRows === 'number')
		return result[0].affectedRows
	return 0
}

type SupportTransferRequest = {
	purchaseId: string
	sourceUserId: string
	targetEmail: string
}

export async function inspectSupportPurchaseTransfer(
	input: SupportTransferRequest,
): Promise<SupportTransferPreflight> {
	const parsedEmail = z.email().safeParse(input.targetEmail.trim().toLowerCase())
	if (!parsedEmail.success) return { state: 'blocked', reason: 'invalid_email' }
	const targetEmail = parsedEmail.data

	const purchase = await courseBuilderAdapter.getPurchase(input.purchaseId)
	if (!purchase) return { state: 'blocked', reason: 'purchase_missing' }
	if (purchase.userId !== input.sourceUserId)
		return { state: 'blocked', reason: 'not_purchase_owner' }
	if (purchase.status !== 'Valid')
		return { state: 'blocked', reason: 'purchase_not_valid' }
	const source = await courseBuilderAdapter.getUserById(input.sourceUserId)
	if (!source || source.email?.trim().toLowerCase() === targetEmail)
		return { state: 'blocked', reason: 'same_user' }

	const transfers = await db.query.purchaseUserTransfer.findMany({
		where: eq(transferTable.purchaseId, input.purchaseId),
	})
	const inFlight = transfers.filter((transfer) =>
		(IN_FLIGHT_TRANSFER_STATES as readonly string[]).includes(transfer.transferState),
	)
	if (inFlight.length)
		return { state: 'blocked', reason: 'transfer_in_flight' }
	const available = transfers.find((transfer) =>
		transfer.transferState === 'AVAILABLE' &&
		transfer.sourceUserId === input.sourceUserId,
	)
	if (!available) return { state: 'blocked', reason: 'transfer_slot_missing' }
	if (isTransferExpired(available))
		return { state: 'blocked', reason: 'transfer_slot_expired' }
	return {
		state: 'ready', transferId: available.id,
		expiresAt: available.expiresAt, targetEmail,
	}
}

export async function initiateSupportPurchaseTransfer(
	input: SupportTransferRequest,
): Promise<SupportTransferInitiation> {
	const preflight = await inspectSupportPurchaseTransfer(input)
	if (preflight.state !== 'ready') return preflight
	const { targetEmail } = preflight

	// Provisioning is intentionally after every no-write guard. The invite only
	// binds an email; it grants no access until the target signs in and accepts.
	const { user: target } = await findOrCreateUserWithPersonalOrg(targetEmail)
	if (target.id === input.sourceUserId)
		return { state: 'blocked', reason: 'same_user' }
	if (!emailProvider) throw new Error('Transfer email provider unavailable')

	const claimed = await db.update(transferTable)
		.set({ targetUserId: target.id, transferState: 'INITIATED' })
		.where(and(
			eq(transferTable.id, preflight.transferId),
			eq(transferTable.transferState, 'AVAILABLE'),
			eq(transferTable.sourceUserId, input.sourceUserId),
		))
	if (rowsAffected(claimed) !== 1)
		return { state: 'blocked', reason: 'transfer_race_lost' }

	try {
		await sendServerEmail({
			email: targetEmail,
			callbackUrl: `${env.NEXT_PUBLIC_URL}/transfer/${preflight.transferId}`,
			baseUrl: env.COURSEBUILDER_URL,
			authOptions: authOptions as NextAuthConfig,
			type: 'transfer',
			html: transferEmailHtml,
			text: transferEmailText,
			expiresAt: preflight.expiresAt,
			adapter: courseBuilderAdapter,
			emailProvider,
		})
	} catch (error) {
		await log.error('purchase_transfer.support_invite_delivery_unknown', {
			purchaseId: input.purchaseId,
			purchaseUserTransferId: preflight.transferId,
			error: error instanceof Error ? error.message : 'Unknown error',
		})
		// Never repeat the invite blindly. An email transport error is ambiguous.
		return { state: 'delivery_unknown', transferId: preflight.transferId }
	}

	await log.info('purchase_transfer.support_invited', {
		purchaseId: input.purchaseId,
		purchaseUserTransferId: preflight.transferId,
	})
	return { state: 'invited', transferId: preflight.transferId }
}
