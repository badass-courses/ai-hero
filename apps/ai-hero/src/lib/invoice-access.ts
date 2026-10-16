import { db } from '@/db'
import {
	merchantCharge,
	purchases,
	purchaseUserTransfer,
} from '@/db/schema'
import { and, asc, eq, inArray, isNotNull, isNull, or } from 'drizzle-orm'

import { purchaseSchema, type Purchase } from '@coursebuilder/core/schemas'

import { pickOriginTransfer, type InvoiceTransferFact } from './invoice-access-rules'

const VISIBLE_PURCHASE_STATES = ['Valid', 'Refunded', 'Restricted']

function toFact(transfer: {
	id: string
	transferState: string
	sourceUserId: string
	completedAt: Date | null
	createdAt: Date
}): InvoiceTransferFact {
	return {
		id: transfer.id,
		state: transfer.transferState,
		sourceUserId: transfer.sourceUserId,
		completedAt: transfer.completedAt,
		createdAt: transfer.createdAt,
	}
}

/** The earliest completed transfer for a purchase: its source paid. */
export async function getOriginTransferForPurchase(purchaseId: string) {
	const transfers = await db.query.purchaseUserTransfer.findMany({
		where: and(
			eq(purchaseUserTransfer.purchaseId, purchaseId),
			eq(purchaseUserTransfer.transferState, 'COMPLETED'),
		),
	})
	return pickOriginTransfer(transfers.map(toFact))
}

async function getOriginPurchaseIds(userId: string, purchaseIds: string[]) {
	if (purchaseIds.length === 0) return []
	const transfers = await db.query.purchaseUserTransfer.findMany({
		where: and(
			inArray(purchaseUserTransfer.purchaseId, purchaseIds),
			eq(purchaseUserTransfer.transferState, 'COMPLETED'),
		),
	})
	const byPurchase = new Map<string, InvoiceTransferFact[]>()
	for (const transfer of transfers) {
		const list = byPurchase.get(transfer.purchaseId) ?? []
		list.push(toFact(transfer))
		byPurchase.set(transfer.purchaseId, list)
	}
	return purchaseIds.filter(
		(id) => pickOriginTransfer(byPurchase.get(id) ?? [])?.sourceUserId === userId,
	)
}

/**
 * Invoice visibility follows the payer and the current holder.
 *
 * A self-service transfer moves Purchase.userId and reassigns
 * MerchantCharge.userId (and MerchantCustomer.userId) to the new holder, so
 * the original payer is only recorded as the source of the first completed
 * PurchaseUserTransfer. MerchantCustomer is not used: one Stripe customer is
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

	// Keep only chains this viewer started: later hops name a holder who
	// never paid as their source. One query covers every candidate purchase.
	const candidateIds = [...new Set(sourceTransfers.map((t) => t.purchaseId))]
	const originPurchaseIds = await getOriginPurchaseIds(userId, candidateIds)

	const chargeIds = chargeRows.map((charge) => charge.id)
	const editableChargeIds = new Set(chargeIds)

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

	return Array.from(
		new Map(billed.map((purchase) => [purchase.id, purchase])).values(),
	).map((purchase) => ({
		...purchase,
		// Editing stays with the billing owner; holders and earlier payers view.
		canEdit: Boolean(
			purchase.merchantChargeId &&
				editableChargeIds.has(purchase.merchantChargeId),
		),
	}))
}
