import process from 'process'
import { courseBuilderAdapter, db } from '@/db'
import {
	merchantCharge,
	purchases,
	purchaseUserTransfer,
} from '@/db/schema'
import { env } from '@/env.mjs'
import {
	getUnpublishedTransferOutboxEvents,
	publishTransferOutboxEvent,
	recordTransferOutboxEvent,
} from '@/purchase-transfer/transfer-outbox'
import {
	isValidSamePersonEvidence,
	resolveInvoicePayer,
	type SamePersonEvidence,
} from '@/lib/invoice-access-rules'
import {
	loadSamePersonEvidence,
	recordSamePersonEvidence,
	samePersonTableExists,
	toTransferFacts,
} from '@/purchase-transfer/same-person'
import { and, eq, inArray, ne } from 'drizzle-orm'
import { Inngest } from 'inngest'
import Stripe from 'stripe'

import { PURCHASE_TRANSFERRED_EVENT } from '@coursebuilder/core/events/purchase-transfer'

export type SupportCompleteInput = {
	transferId: string
	purchaseId: string
	sourceUserId: string
	targetEmail: string
	// Support verified both accounts are one person: the target becomes the
	// invoice payer. Absent means a normal move. Never inferred.
	samePerson?: SamePersonEvidence
}

export type SupportCompleteResult =
	| { state: 'ready'; transferId: string }
	| { state: 'completion_requested'; transferId: string }
	| { state: 'completion_pending'; transferId: string; reason: string }
	| { state: 'completed'; transferId: string }
	| { state: 'blocked'; reason: string }

const normalizeEmail = (value: string) => value.trim().toLowerCase()

function getRowsAffected(result: unknown): number {
	if (
		result &&
		typeof result === 'object' &&
		'rowsAffected' in result &&
		typeof (result as { rowsAffected: unknown }).rowsAffected === 'number'
	) {
		return (result as { rowsAffected: number }).rowsAffected
	}
	if (Array.isArray(result)) {
		const header = result[0]
		if (
			header &&
			typeof header === 'object' &&
			'affectedRows' in header &&
			typeof (header as { affectedRows: unknown }).affectedRows === 'number'
		) {
			return (header as { affectedRows: number }).affectedRows
		}
	}
	return 0
}

async function sendPurchaseTransferredEvent(params: {
	purchaseId: string
	sourceUserId: string
	targetUserId: string
	purchaseUserTransferId: string
	targetEmail: string
}) {
	if (!process.env.INNGEST_EVENT_KEY) {
		throw new Error('INNGEST_EVENT_KEY is not configured')
	}
	const inngest = new Inngest({
		id:
			process.env.INNGEST_APP_NAME ||
			process.env.NEXT_PUBLIC_SITE_TITLE ||
			'Purchase Transfer',
		eventKey: process.env.INNGEST_EVENT_KEY,
	})
	await inngest.send({
		name: PURCHASE_TRANSFERRED_EVENT,
		data: {
			purchaseId: params.purchaseId,
			sourceUserId: params.sourceUserId,
			targetUserId: params.targetUserId,
			purchaseUserTransferId: params.purchaseUserTransferId,
		},
		user: { id: params.targetUserId, email: params.targetEmail },
	})
}

async function inspectStripeRefunds(identifier: string) {
	try {
		const stripe = new Stripe(env.STRIPE_SECRET_TOKEN, {
			apiVersion: '2024-06-20',
		})
		const charge = await stripe.charges.retrieve(identifier, {
			expand: ['refunds'],
		})
		if ('deleted' in charge && charge.deleted) {
			return { ok: false as const, reason: 'charge_deleted' }
		}
		const hasRefund =
			charge.refunded ||
			charge.amount_refunded > 0 ||
			charge.refunds?.data.some((refund) =>
				['pending', 'succeeded'].includes(refund.status ?? ''),
			)
		return hasRefund
			? { ok: false as const, reason: 'refund_present' }
			: { ok: true as const }
	} catch {
		return { ok: false as const, reason: 'refund_state_unverifiable' }
	}
}

async function loadGuardedContext(input: SupportCompleteInput) {
	const transfer = await courseBuilderAdapter.getPurchaseUserTransferById({
		id: input.transferId,
	})
	if (!transfer) return { ok: false as const, reason: 'transfer_not_found' }
	if (
		transfer.purchaseId !== input.purchaseId ||
		transfer.sourceUserId !== input.sourceUserId
	) {
		return { ok: false as const, reason: 'transfer_identity_mismatch' }
	}
	if (!transfer.targetUserId) {
		return { ok: false as const, reason: 'transfer_target_missing' }
	}
	if (transfer.expiresAt && transfer.expiresAt.getTime() <= Date.now()) {
		return { ok: false as const, reason: 'transfer_expired' }
	}
	if (!['INITIATED', 'VERIFIED', 'COMPLETED'].includes(transfer.transferState)) {
		return { ok: false as const, reason: 'transfer_not_completable' }
	}

	const [purchase, sourceUser, targetUser] = await Promise.all([
		courseBuilderAdapter.getPurchase(input.purchaseId),
		courseBuilderAdapter.getUserById(input.sourceUserId),
		courseBuilderAdapter.getUserById(transfer.targetUserId),
	])
	if (!purchase) return { ok: false as const, reason: 'purchase_not_found' }
	if (!sourceUser || !targetUser) {
		return { ok: false as const, reason: 'transfer_user_missing' }
	}
	if (normalizeEmail(targetUser.email) !== normalizeEmail(input.targetEmail)) {
		return { ok: false as const, reason: 'target_email_mismatch' }
	}
	if (sourceUser.id === targetUser.id) {
		return { ok: false as const, reason: 'same_user_transfer' }
	}
	if (purchase.status !== 'Valid') {
		return { ok: false as const, reason: 'purchase_not_valid' }
	}
	if (purchase.bulkCouponId || purchase.redeemedBulkCouponId) {
		return { ok: false as const, reason: 'team_purchase_not_supported' }
	}
	if (
		transfer.transferState === 'INITIATED' &&
		purchase.userId !== input.sourceUserId
	) {
		return { ok: false as const, reason: 'source_no_longer_owns_purchase' }
	}
	if (
		['VERIFIED', 'COMPLETED'].includes(transfer.transferState) &&
		purchase.userId !== targetUser.id
	) {
		return { ok: false as const, reason: 'verified_owner_mismatch' }
	}

	const openConflicts = await db.query.purchaseUserTransfer.findMany({
		where: and(
			eq(purchaseUserTransfer.purchaseId, purchase.id),
			inArray(purchaseUserTransfer.transferState, [
				'AVAILABLE',
				'INITIATED',
				'VERIFIED',
			]),
			ne(purchaseUserTransfer.id, transfer.id),
		),
	})
	if (openConflicts.length > 0) {
		return { ok: false as const, reason: 'conflicting_transfer' }
	}

	const duplicatePurchases = await db.query.purchases.findMany({
		where: and(
			eq(purchases.userId, targetUser.id),
			eq(purchases.productId, purchase.productId),
			inArray(purchases.status, ['Valid', 'Restricted']),
			ne(purchases.id, purchase.id),
		),
	})
	if (duplicatePurchases.length > 0) {
		return { ok: false as const, reason: 'destination_already_owns_product' }
	}

	const targetEntitlements = await courseBuilderAdapter.getEntitlementsForUser({
		userId: targetUser.id,
	})
	if (
		targetEntitlements.some((entitlement) => {
			const metadata = entitlement.metadata as Record<string, unknown> | null
			return metadata?.eligibilityProductId === purchase.productId
		})
	) {
		return { ok: false as const, reason: 'destination_already_has_access' }
	}

	if (!purchase.merchantChargeId) {
		return { ok: false as const, reason: 'billing_charge_missing' }
	}
	const billingCharge = await db.query.merchantCharge.findFirst({
		where: eq(merchantCharge.id, purchase.merchantChargeId),
	})
	// The mover must hold the purchase. The charge stays with the payer after
	// a transfer, so its user is not the holder and is not compared to it.
	// (INITIATED rows are checked above; a resumed VERIFIED/COMPLETED row
	// already moved the purchase to the target.)
	if (
		purchase.userId !== sourceUser.id &&
		!(
			['VERIFIED', 'COMPLETED'].includes(transfer.transferState) &&
			purchase.userId === targetUser.id
		)
	) {
		return { ok: false as const, reason: 'source_no_longer_owns_purchase' }
	}
	// A move must never leave the charge with no payer, nor change who the
	// payer is. The payer is the earliest completed transfer's source, else the
	// charge's user. This move completes a transfer from `sourceUser`; the row
	// is the same one the workflow marks COMPLETED, so no second row is written.
	const completedTransfers = await toTransferFacts(
		await db.query.purchaseUserTransfer.findMany({
			where: and(
				eq(purchaseUserTransfer.purchaseId, purchase.id),
				eq(purchaseUserTransfer.transferState, 'COMPLETED'),
				ne(purchaseUserTransfer.id, transfer.id),
			),
		}),
	)
	if (!billingCharge) {
		return { ok: false as const, reason: 'billing_charge_missing' }
	}
	const payerBefore = resolveInvoicePayer({
		chargeUserId: billingCharge.userId,
		transfers: completedTransfers,
	})
	// A same-person move is the one move allowed to change the payer, and only
	// to the target. It needs valid evidence, the table to hold it, and the
	// mover to be the current payer: a holder who never paid cannot hand the
	// invoice to their other account.
	if (input.samePerson !== undefined) {
		if (!isValidSamePersonEvidence(input.samePerson)) {
			return { ok: false as const, reason: 'same_person_evidence_invalid' }
		}
		if (!(await samePersonTableExists())) {
			return { ok: false as const, reason: 'same_person_table_missing' }
		}
		// Only the INITIATED claim writes the flag. A transfer past it must
		// already carry the same flag, or the request would record nothing.
		if (transfer.transferState !== 'INITIATED') {
			const [recorded] = (
				await loadSamePersonEvidence([transfer.id])
			).values()
			if (!recorded) {
				return {
					ok: false as const,
					reason: 'same_person_cannot_be_added_after_claim',
				}
			}
		}
	}
	const payerAfter = resolveInvoicePayer({
		chargeUserId: billingCharge.userId,
		transfers: [
			...completedTransfers,
			{
				id: transfer.id,
				state: 'COMPLETED',
				sourceUserId: sourceUser.id,
				targetUserId: targetUser.id,
				completedAt: new Date(),
				samePerson: input.samePerson ?? null,
			},
		],
	})
	// MerchantCharge.userId is NOT NULL, so this is defense in depth: a move
	// must never leave a charge with no payer.
	if (!payerBefore) {
		return {
			ok: false as const,
			reason: 'move_would_leave_charge_without_payer',
		}
	}
	if (input.samePerson !== undefined) {
		if (payerBefore !== sourceUser.id) {
			return { ok: false as const, reason: 'same_person_source_not_payer' }
		}
		if (payerAfter !== targetUser.id) {
			return { ok: false as const, reason: 'move_would_change_invoice_payer' }
		}
	} else if (payerBefore !== payerAfter) {
		return { ok: false as const, reason: 'move_would_change_invoice_payer' }
	}
	const refundState = await inspectStripeRefunds(billingCharge.identifier)
	if (!refundState.ok) return refundState

	return {
		ok: true as const,
		transfer,
		purchase,
		sourceUser,
		targetUser,
		billingCharge,
		samePerson: input.samePerson,
	}
}

export async function inspectSupportPurchaseTransferCompletion(
	input: SupportCompleteInput,
): Promise<SupportCompleteResult> {
	const context = await loadGuardedContext(input)
	if (!context.ok) return { state: 'blocked', reason: context.reason }
	if (context.transfer.transferState === 'COMPLETED') {
		return { state: 'completed', transferId: context.transfer.id }
	}
	return { state: 'ready', transferId: context.transfer.id }
}

export async function completeSupportPurchaseTransfer(
	input: SupportCompleteInput,
): Promise<SupportCompleteResult> {
	const context = await loadGuardedContext(input)
	if (!context.ok) return { state: 'blocked', reason: context.reason }
	if (context.transfer.transferState === 'COMPLETED') {
		return { state: 'completed', transferId: context.transfer.id }
	}

	let outboxId: string | null = null
	if (context.transfer.transferState === 'INITIATED') {
		outboxId = await db.transaction(async (tx) => {
			const claimed = await tx
				.update(purchaseUserTransfer)
				.set({ transferState: 'VERIFIED', confirmedAt: new Date() })
				.where(
					and(
						eq(purchaseUserTransfer.id, context.transfer.id),
						eq(purchaseUserTransfer.purchaseId, context.purchase.id),
						eq(purchaseUserTransfer.sourceUserId, context.sourceUser.id),
						eq(purchaseUserTransfer.targetUserId, context.targetUser.id),
						eq(purchaseUserTransfer.transferState, 'INITIATED'),
					),
				)
			if (getRowsAffected(claimed) !== 1) {
				throw new Error('transfer_claim_race')
			}

			const moved = await tx
				.update(purchases)
				.set({ userId: context.targetUser.id })
				.where(
					and(
						eq(purchases.id, context.purchase.id),
						eq(purchases.userId, context.sourceUser.id),
					),
				)
			if (getRowsAffected(moved) !== 1) {
				throw new Error('purchase_owner_race')
			}

			if (context.samePerson) {
				await recordSamePersonEvidence(tx, context.transfer.id, context.samePerson)
			}

			return recordTransferOutboxEvent(tx, {
				purchaseUserTransferId: context.transfer.id,
				purchaseId: context.purchase.id,
				sourceUserId: context.sourceUser.id,
				targetUserId: context.targetUser.id,
				eventName: PURCHASE_TRANSFERRED_EVENT,
				payload: {
					purchaseId: context.purchase.id,
					sourceUserId: context.sourceUser.id,
					targetUserId: context.targetUser.id,
					purchaseUserTransferId: context.transfer.id,
				},
			})
		})
	} else {
		const unpublished = await getUnpublishedTransferOutboxEvents(
			context.transfer.id,
		)
		outboxId = unpublished[0]?.id ?? null
	}

	const billingReadback = await db.query.merchantCharge.findFirst({
		where: eq(merchantCharge.id, context.billingCharge.id),
	})
	if (billingReadback?.userId !== context.billingCharge.userId) {
		throw new Error('billing_owner_changed')
	}
	if (!outboxId) {
		return {
			state: 'completion_pending',
			transferId: context.transfer.id,
			reason: 'outbox_missing',
		}
	}

	const publish = await publishTransferOutboxEvent({
		outboxId,
		send: () =>
			sendPurchaseTransferredEvent({
				purchaseId: context.purchase.id,
				sourceUserId: context.sourceUser.id,
				targetUserId: context.targetUser.id,
				purchaseUserTransferId: context.transfer.id,
				targetEmail: context.targetUser.email,
			}),
	})
	if (!publish.published) {
		return {
			state: 'completion_pending',
			transferId: context.transfer.id,
			reason: 'event_publish_failed',
		}
	}
	return { state: 'completion_requested', transferId: context.transfer.id }
}
