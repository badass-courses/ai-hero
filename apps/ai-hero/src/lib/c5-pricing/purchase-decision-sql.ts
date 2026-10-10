import type { DbExecutor } from '@/db'
import { purchases } from '@/db/schema'
import { and, eq, isNull, sql } from 'drizzle-orm'

import { C5_PRODUCT_ID } from './decision'
import {
	C5_DECISION_FIELD,
	C5_DUPLICATE_FIELD,
	parseSavedDecision,
	type C5DecisionStore,
	type C5PurchaseRow,
} from './purchase-decision'

type PurchaseRecord = typeof purchases.$inferSelect

const toRow = (purchase: PurchaseRecord): C5PurchaseRow => ({
	id: purchase.id,
	userId: purchase.userId ?? null,
	productId: purchase.productId,
	status: purchase.status,
	bulkCouponId: purchase.bulkCouponId ?? null,
	redeemedBulkCouponId: purchase.redeemedBulkCouponId ?? null,
	decision: parseSavedDecision(
		(purchase.fields as Record<string, unknown> | null)?.[C5_DECISION_FIELD],
	),
})

/**
 * The saved decision lives in `Purchase.fields`. Writes are a single
 * `JSON_SET` on one key, so a concurrent writer of another key (purchase
 * benefits, attribution) never loses its value.
 */
export function c5DecisionStoreOn(
	database: DbExecutor,
	/** Tests point it at a fixture product; production is always C5. */
	productId: string = C5_PRODUCT_ID,
): C5DecisionStore {
	const setField = (purchaseId: string, path: string, value: unknown) =>
		database
			.update(purchases)
			.set({
				fields: sql`JSON_SET(COALESCE(${purchases.fields}, JSON_OBJECT()), ${path}, CAST(${JSON.stringify(value)} AS JSON))`,
			})
			.where(eq(purchases.id, purchaseId))

	return {
		async purchase(purchaseId) {
			const [row] = await database
				.select()
				.from(purchases)
				.where(eq(purchases.id, purchaseId))
				.limit(1)
			return row ? toRow(row) : null
		},
		async saveDecision(purchaseId, decision) {
			await setField(purchaseId, `$.${C5_DECISION_FIELD}`, decision)
		},
		async markDuplicate(purchaseId, duplicateOf) {
			await setField(purchaseId, `$.${C5_DUPLICATE_FIELD}`, duplicateOf)
		},
		async individualPurchases(userId) {
			const rows = await database
				.select()
				.from(purchases)
				.where(
					and(
						eq(purchases.userId, userId),
						eq(purchases.productId, productId),
						isNull(purchases.bulkCouponId),
						isNull(purchases.redeemedBulkCouponId),
					),
				)
			return rows.map(toRow)
		},
		async spentBy(creditSource) {
			const rows = await database
				.select({ id: purchases.id })
				.from(purchases)
				.where(
					and(
						eq(purchases.productId, productId),
						sql`JSON_UNQUOTE(JSON_EXTRACT(${purchases.fields}, ${`$.${C5_DECISION_FIELD}.creditSource`})) = ${creditSource}`,
					),
				)
			return rows.map((row) => row.id)
		},
	}
}
