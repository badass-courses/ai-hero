import { db } from '@/db'
import {
	merchantCharge,
	merchantCustomer,
	purchases,
	purchaseUserTransfer,
} from '@/db/schema'
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

/** The account on the charge's MerchantCustomer, the payer of record. */
export async function getPayerUserIdForCustomer(
	merchantCustomerId: string | null | undefined,
) {
	if (!merchantCustomerId) return null
	const customer = await db.query.merchantCustomer.findFirst({
		where: eq(merchantCustomer.id, merchantCustomerId),
		columns: { userId: true },
	})
	return customer?.userId ?? null
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
): Promise<(Purchase & { canEdit: boolean })[]> {
	if (!userId) return []

	const [chargeRows, customerRows, sourceTransfers] = await Promise.all([
		db.query.merchantCharge.findMany({
			where: eq(merchantCharge.userId, userId),
			columns: { id: true },
		}),
		db.query.merchantCustomer.findMany({
			where: eq(merchantCustomer.userId, userId),
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

	// Charges of customers the viewer is the payer of record for.
	const customerChargeRows = customerRows.length
		? await db.query.merchantCharge.findMany({
				where: inArray(
					merchantCharge.merchantCustomerId,
					customerRows.map((customer) => customer.id),
				),
				columns: { id: true },
			})
		: []
	const chargeIds = [
		...new Set([...chargeRows, ...customerChargeRows].map((c) => c.id)),
	]
	const editableChargeIds = new Set(chargeRows.map((charge) => charge.id))

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
