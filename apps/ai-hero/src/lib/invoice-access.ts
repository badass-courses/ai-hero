import { db } from '@/db'
import { merchantCharge, purchases } from '@/db/schema'
import { and, asc, eq, inArray } from 'drizzle-orm'

import { purchaseSchema, type Purchase } from '@coursebuilder/core/schemas'

const VISIBLE_PURCHASE_STATES = ['Valid', 'Refunded', 'Restricted']

/**
 * Invoice ownership follows the payer, not the current learner.
 *
 * Purchase transfers intentionally move Purchase.userId so course access can
 * move. MerchantCharge.userId remains the original payer. This query follows
 * only that billing identity, preserving the payer's invoice list after a
 * transfer without granting invoice visibility to the recipient.
 */
export async function getInvoicePurchasesForUser(
	userId: string | null | undefined,
): Promise<Purchase[]> {
	if (!userId) return []

	const chargeRows = await db.query.merchantCharge.findMany({
		where: eq(merchantCharge.userId, userId),
		columns: { id: true },
	})
	if (chargeRows.length === 0) return []

	const billedRows = await db.query.purchases.findMany({
		where: and(
			inArray(
				purchases.merchantChargeId,
				chargeRows.map((charge) => charge.id),
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
