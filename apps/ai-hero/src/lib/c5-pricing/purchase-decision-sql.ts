import type { DbExecutor } from '@/db'
import { purchaseDecision, purchases } from '@/db/schema'
import { and, eq, isNull, sql } from 'drizzle-orm'

import { C5_PRODUCT_ID } from './decision'
import {
	C5_DUPLICATE_FIELD,
	parseSavedDecision,
	type C5DecisionStore,
	type C5PurchaseRow,
} from './purchase-decision'

type PurchaseRecord = typeof purchases.$inferSelect
type DecisionRecord = typeof purchaseDecision.$inferSelect

export const decisionFromRow = (row: DecisionRecord | null) =>
	row &&
	parseSavedDecision({
		v: 1,
		decisionRef: row.decisionRef,
		creditSource: row.creditSource,
		codeRef: row.codeRef,
		basis: row.basis,
		contract: row.contract,
		engineVersion: row.engineVersion,
		policyVersion: row.policyVersion,
		accessRestriction: row.restriction,
		expectedTotalCents: row.amountCents,
		checkoutSessionId: row.checkoutSessionId,
		savedAt: row.createdAt.toISOString(),
	})

const toRow = (
	purchase: PurchaseRecord,
	decision: DecisionRecord | null,
): C5PurchaseRow => ({
	id: purchase.id,
	userId: purchase.userId ?? null,
	productId: purchase.productId,
	status: purchase.status,
	bulkCouponId: purchase.bulkCouponId ?? null,
	redeemedBulkCouponId: purchase.redeemedBulkCouponId ?? null,
	decision: decisionFromRow(decision),
})

/** Only inserts ledger rows. Replays cannot overwrite the first decision. */
export function c5DecisionStoreOn(
	database: DbExecutor,
	productId: string = C5_PRODUCT_ID,
): C5DecisionStore {
	const readDecision = async (purchaseId: string) => {
		const [row] = await database
			.select()
			.from(purchaseDecision)
			.where(eq(purchaseDecision.purchaseId, purchaseId))
			.limit(1)
		return row ?? null
	}
	return {
		async purchase(purchaseId) {
			const [row] = await database
				.select()
				.from(purchases)
				.where(eq(purchases.id, purchaseId))
				.limit(1)
			return row ? toRow(row, await readDecision(purchaseId)) : null
		},
		async saveDecision(purchaseId, decision) {
			await database
				.insert(purchaseDecision)
				.values({
					purchaseId,
					productId,
					decisionRef: decision.decisionRef,
					creditSource: decision.creditSource,
					codeRef: decision.codeRef,
					basis: decision.basis,
					restriction: decision.accessRestriction,
					amountCents: decision.expectedTotalCents,
					contract: decision.contract,
					engineVersion: decision.engineVersion,
					policyVersion: decision.policyVersion,
					checkoutSessionId: decision.checkoutSessionId,
					createdAt: new Date(decision.savedAt),
				})
				.onDuplicateKeyUpdate({
					set: { purchaseId: sql`${purchaseDecision.purchaseId}` },
				})
			const stored = await readDecision(purchaseId)
			if (!stored) throw new Error('purchase-decision-readback-missing')
			return stored.decisionRef === decision.decisionRef ? 'saved' : 'conflict'
		},
		async markDuplicate(purchaseId, duplicateOf) {
			await database
				.update(purchases)
				.set({
					fields: sql`JSON_SET(COALESCE(${purchases.fields}, JSON_OBJECT()), ${`$.${C5_DUPLICATE_FIELD}`}, CAST(${JSON.stringify(duplicateOf)} AS JSON))`,
				})
				.where(eq(purchases.id, purchaseId))
		},
		async individualPurchases(userId) {
			const rows = await database
				.select({ purchase: purchases, decision: purchaseDecision })
				.from(purchases)
				.leftJoin(
					purchaseDecision,
					eq(purchaseDecision.purchaseId, purchases.id),
				)
				.where(
					and(
						eq(purchases.userId, userId),
						eq(purchases.productId, productId),
						isNull(purchases.bulkCouponId),
						isNull(purchases.redeemedBulkCouponId),
					),
				)
			return rows.map((row) => toRow(row.purchase, row.decision))
		},
		async spentBy(creditSource) {
			const rows = await database
				.select({ id: purchaseDecision.purchaseId })
				.from(purchaseDecision)
				.where(
					and(
						eq(purchaseDecision.productId, productId),
						eq(purchaseDecision.creditSource, creditSource),
					),
				)
			return rows.map((row) => row.id)
		},
	}
}
