import { db } from '@/db'
import { merchantCharge, purchases, purchaseUserTransfer } from '@/db/schema'
import { and, asc, eq, inArray, isNotNull, or } from 'drizzle-orm'

import { purchaseSchema, type Purchase } from '@coursebuilder/core/schemas'

import { pickOriginTransfer } from './invoice-access-rules'

const VISIBLE_PURCHASE_STATES = ['Valid', 'Refunded', 'Restricted']

/** Completed transfers for a purchase, oldest chain first via the rules. */
export async function getOriginTransferForPurchase(purchaseId: string) {
	const transfers = await db.query.purchaseUserTransfer.findMany({
		where: and(
			eq(purchaseUserTransfer.purchaseId, purchaseId),
			eq(purchaseUserTransfer.transferState, 'COMPLETED'),
		),
	})
	return pickOriginTransfer(
		transfers.map((transfer) => ({
			state: transfer.transferState,
			sourceUserId: transfer.sourceUserId,
			completedAt: transfer.completedAt,
			createdAt: transfer.createdAt,
		})),
	)
}

/**
 * Invoice visibility follows the payer and the current holder.
 *
 * A purchase transfer moves Purchase.userId and reassigns
 * MerchantCharge.userId to the new holder, so the original payer is only
 * recorded as the source of the first completed PurchaseUserTransfer. The
 * list returns purchases that are billed to the viewer's charges, held by
 * the viewer, or originally paid by the viewer. Previous holders who never
 * paid see nothing.
 */
export async function getInvoicePurchasesForUser(
	userId: string | null | undefined,
): Promise<Purchase[]> {
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
	// never paid as their source.
	const originPurchaseIds: string[] = []
	for (const purchaseId of new Set(sourceTransfers.map((t) => t.purchaseId))) {
		const origin = await getOriginTransferForPurchase(purchaseId)
		if (origin?.sourceUserId === userId) originPurchaseIds.push(purchaseId)
	}

	const billedRows = await db.query.purchases.findMany({
		where: and(
			or(
				chargeRows.length > 0
					? inArray(
							purchases.merchantChargeId,
							chargeRows.map((charge) => charge.id),
						)
					: undefined,
				and(eq(purchases.userId, userId), isNotNull(purchases.merchantChargeId)),
				originPurchaseIds.length > 0
					? inArray(purchases.id, originPurchaseIds)
					: undefined,
			),
			inArray(purchases.status, VISIBLE_PURCHASE_STATES),
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
	)
}
