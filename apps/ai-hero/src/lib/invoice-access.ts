import { db } from '@/db'
import {
	merchantCharge,
	purchases,
	purchaseUserTransfer,
} from '@/db/schema'
import { and, asc, eq, inArray, isNotNull, isNull, or } from 'drizzle-orm'

import { purchaseSchema, type Purchase } from '@coursebuilder/core/schemas'

import { toTransferFacts } from '@/purchase-transfer/same-person'

import {
	canEditInvoice,
	pickOriginTransfer,
	resolveInvoicePayer,
	type InvoiceTransferFact,
} from './invoice-access-rules'

const VISIBLE_PURCHASE_STATES = ['Valid', 'Refunded', 'Restricted']

/** Every completed transfer for a purchase, with same-person evidence. */
export async function getCompletedTransfersForPurchase(
	purchaseId: string,
): Promise<InvoiceTransferFact[]> {
	const transfers = await db.query.purchaseUserTransfer.findMany({
		where: and(
			eq(purchaseUserTransfer.purchaseId, purchaseId),
			eq(purchaseUserTransfer.transferState, 'COMPLETED'),
		),
	})
	return toTransferFacts(transfers)
}

async function getCompletedTransfersByPurchase(purchaseIds: string[]) {
	const byPurchase = new Map<string, InvoiceTransferFact[]>()
	if (purchaseIds.length === 0) return byPurchase
	const transfers = await db.query.purchaseUserTransfer.findMany({
		where: and(
			inArray(purchaseUserTransfer.purchaseId, purchaseIds),
			eq(purchaseUserTransfer.transferState, 'COMPLETED'),
		),
	})
	const facts = await toTransferFacts(transfers)
	transfers.forEach((transfer, index) => {
		const list = byPurchase.get(transfer.purchaseId) ?? []
		list.push(facts[index]!)
		byPurchase.set(transfer.purchaseId, list)
	})
	return byPurchase
}

/**
 * Invoice visibility follows the payer and the current holder.
 *
 * A transfer moves Purchase.userId only; MerchantCharge.userId keeps naming
 * the payer. Transfers made before that fix also reassigned
 * MerchantCharge.userId (and MerchantCustomer.userId) to the new holder, so
 * for those the original payer is only recorded as the source of the first
 * completed PurchaseUserTransfer. MerchantCustomer is not used: one Stripe customer is
 * shared across a buyer's charges, so a transfer of one purchase would hand
 * the buyer's other invoices to the new holder.
 *
 * The list returns purchases billed to the viewer's charges, held by the
 * viewer, or originally paid by the viewer. Redeemed seats and previous
 * holders who never paid see nothing.
 */
export async function getInvoicePurchasesForUser(
	userId: string | null | undefined,
): Promise<(Purchase & { canEdit: boolean })[]> {
	if (!userId) return []

	const [chargeRows, sourceTransfers] = await Promise.all([
		db.query.merchantCharge.findMany({
			where: eq(merchantCharge.userId, userId),
			columns: { id: true },
		}),
		db.query.purchaseUserTransfer.findMany({
			where: and(
				eq(purchaseUserTransfer.sourceUserId, userId),
				eq(purchaseUserTransfer.transferState, 'COMPLETED'),
			),
			columns: { purchaseId: true },
		}),
	])

	// Keep only chains this viewer started or pays for: later hops name a
	// holder who never paid as their source. One query covers every candidate.
	const candidateIds = [...new Set(sourceTransfers.map((t) => t.purchaseId))]
	const candidateTransfers = await getCompletedTransfersByPurchase(candidateIds)
	// This is the second transfer query for the same purchases: the one above
	// only finds candidates by source (cheap, column-limited); this one loads
	// the full chains so the payer can be resolved with same-person flags.
	const originPurchaseIds = candidateIds.filter((id) => {
		const transfers = candidateTransfers.get(id) ?? []
		return (
			// The original payer keeps the purchase in their list after a move,
			// even once a same-person hop made someone else the payer.
			pickOriginTransfer(transfers)?.sourceUserId === userId ||
			resolveInvoicePayer({ chargeUserId: null, transfers }) === userId
		)
	})

	const chargeIds = chargeRows.map((charge) => charge.id)

	const billedRows = await db.query.purchases.findMany({
		where: and(
			or(
				chargeIds.length > 0
					? inArray(purchases.merchantChargeId, chargeIds)
					: undefined,
				and(eq(purchases.userId, userId), isNotNull(purchases.merchantChargeId)),
				originPurchaseIds.length > 0
					? inArray(purchases.id, originPurchaseIds)
					: undefined,
			),
			inArray(purchases.status, VISIBLE_PURCHASE_STATES),
			// A redeemed team seat is not the buyer's invoice, charge id or not.
			isNull(purchases.redeemedBulkCouponId),
		),
		with: {
			product: true,
			user: true,
			bulkCoupon: true,
		},
		orderBy: asc(purchases.createdAt),
	})

	const billed = purchaseSchema.array().parse(billedRows)

	const unique = Array.from(
		new Map(billed.map((purchase) => [purchase.id, purchase])).values(),
	)
	// Editing follows the payer: the source of the earliest completed transfer,
	// else the charge's user. Holders who did not pay view only. Covers
	// purchases transferred before charges stayed with the payer.
	const [payerCharges, transfersByPurchase] = await Promise.all([
		unique.some((purchase) => purchase.merchantChargeId)
			? db.query.merchantCharge.findMany({
					where: inArray(
						merchantCharge.id,
						unique.flatMap((purchase) =>
							purchase.merchantChargeId ? [purchase.merchantChargeId] : [],
						),
					),
					columns: { id: true, userId: true },
				})
			: [],
		getCompletedTransfersByPurchase(unique.map((purchase) => purchase.id)),
	])
	const chargeUserById = new Map(payerCharges.map((c) => [c.id, c.userId]))

	return unique.map((purchase) => ({
		...purchase,
		canEdit: Boolean(
			purchase.merchantChargeId &&
				canEditInvoice({
					viewerId: userId,
					payerUserId: chargeUserById.get(purchase.merchantChargeId),
					holderUserId: purchase.userId,
					transfers: transfersByPurchase.get(purchase.id) ?? [],
				}),
		),
	}))
}
