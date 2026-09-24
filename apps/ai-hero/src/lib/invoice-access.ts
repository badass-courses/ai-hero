import { courseBuilderAdapter, db } from '@/db'
import { merchantCharge, purchases } from '@/db/schema'
import { asc, eq, inArray } from 'drizzle-orm'

import type { Purchase } from '@coursebuilder/core/schemas'

const VISIBLE_PURCHASE_STATES = ['Valid', 'Refunded', 'Restricted']

/**
 * Invoice ownership follows the payer, not the current learner.
 *
 * Purchase transfers intentionally move Purchase.userId so course access can
 * move. MerchantCharge.userId remains the original payer. This query returns
 * both sets and deduplicates them, preserving the payer's invoice list after a
 * transfer without granting them the learner's course access.
 */
export async function getInvoicePurchasesForUser(
	userId: string | null | undefined,
): Promise<Purchase[]> {
	if (!userId) return []

	const owned = await courseBuilderAdapter.getPurchasesForUser(userId)
	const chargeRows = await db.query.merchantCharge.findMany({
		where: eq(merchantCharge.userId, userId),
		columns: { id: true },
	})
	if (chargeRows.length === 0) return owned

	const billedRows = await db.query.purchases.findMany({
		where: inArray(
			purchases.merchantChargeId,
			chargeRows.map((charge) => charge.id),
		),
		columns: { id: true },
		orderBy: asc(purchases.createdAt),
	})
	const billed = (
		await Promise.all(
			billedRows.map((row) => courseBuilderAdapter.getPurchase(row.id)),
		)
	).filter(
		(purchase): purchase is Purchase =>
			purchase !== null && VISIBLE_PURCHASE_STATES.includes(purchase.status),
	)

	return Array.from(
		new Map([...owned, ...billed].map((purchase) => [purchase.id, purchase])).values(),
	)
}
