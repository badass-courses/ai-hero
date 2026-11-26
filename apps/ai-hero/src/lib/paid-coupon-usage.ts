import type { DbExecutor } from '@/db/client'
import { coupon, purchases } from '@/db/schema'
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm'

import type { CouponPort } from '@coursebuilder/core/ports'

const activePurchaseStatuses = ['Valid', 'Restricted']

type Usage = {
	id: string
	maxUses: number
	usedCount: number
	restrictedToProductId?: string | null
}

async function isTeamCoupon(db: DbExecutor, couponId: string) {
	const [teamPurchase] = await db
		.select({ id: purchases.id })
		.from(purchases)
		.where(
			or(
				eq(purchases.bulkCouponId, couponId),
				eq(purchases.redeemedBulkCouponId, couponId),
			),
		)
		.limit(1)
	return Boolean(teamPurchase)
}

/** Read through a stale counter until paid-purchase accounting catches up. */
export async function withEffectivePaidCouponUsage<T extends Usage>(
	db: DbExecutor,
	row: T,
): Promise<T & { paidCouponUsedUp?: true }> {
	if (row.maxUses <= 0) return row
	if (row.usedCount < row.maxUses) {
		// There is no couponId index. Don't scan all purchases for a global coupon.
		if (!row.restrictedToProductId) return row
		const [lastUse] = await db
			.select({ id: purchases.id })
			.from(purchases)
			.where(
				and(
					eq(purchases.productId, row.restrictedToProductId),
					eq(purchases.couponId, row.id),
					inArray(purchases.status, activePurchaseStatuses),
					isNull(purchases.bulkCouponId),
					isNull(purchases.redeemedBulkCouponId),
				),
			)
			.limit(1)
			.offset(row.maxUses - 1)
		if (!lastUse) return row
	}
	if (await isTeamCoupon(db, row.id)) return row
	return {
		...row,
		usedCount: Math.max(row.usedCount, row.maxUses),
		paidCouponUsedUp: true,
	}
}

/** Only the normal pricing reads are projected. Team redemption owns its counter. */
export function withPaidCouponUsage<
	T extends Pick<
		CouponPort,
		'getCoupon' | 'couponForIdOrCode' | 'getDefaultCoupon'
	>,
>(adapter: T, db: DbExecutor) {
	const couponForIdOrCode = adapter.couponForIdOrCode.bind(adapter)
	const getDefaultCoupon = adapter.getDefaultCoupon.bind(adapter)
	return Object.assign(adapter, {
		getCouponForDisplay: async (key: string) => {
			const row = await adapter.getCoupon(key)
			return row && withEffectivePaidCouponUsage(db, row)
		},
		couponForIdOrCode: async (input: Parameters<T['couponForIdOrCode']>[0]) => {
			const row = await couponForIdOrCode(input)
			return row &&
				!(await withEffectivePaidCouponUsage(db, row)).paidCouponUsedUp
				? row
				: null
		},
		getDefaultCoupon: async (productIds?: string[]) => {
			const result = await getDefaultCoupon(productIds)
			if (!result) return null
			const row = await withEffectivePaidCouponUsage(db, result.defaultCoupon)
			return row.paidCouponUsedUp ? null : result
		},
	})
}

/** The same purchase cannot increment twice, even on concurrent event replay. */
export async function recordPaidCouponUse(
	db: Pick<DbExecutor, 'transaction'>,
	purchaseId: string,
) {
	return db.transaction(
		async (
			tx,
		): Promise<'counted' | 'already-counted' | 'ineligible' | 'pending'> => {
			const [purchase] = await tx
				.select({
					couponId: purchases.couponId,
					counted: sql<number>`JSON_CONTAINS_PATH(${purchases.fields}, 'one', '$.paidCouponUseCounted')`,
					fieldsType: sql<string | null>`JSON_TYPE(${purchases.fields})`,
					paid: sql<number>`(${purchases.merchantChargeId} IS NOT NULL AND ${purchases.totalAmount} > 0)`,
					status: purchases.status,
					bulkCouponId: purchases.bulkCouponId,
					redeemedBulkCouponId: purchases.redeemedBulkCouponId,
				})
				.from(purchases)
				.where(eq(purchases.id, purchaseId))
				.for('update')
			if (!purchase) return 'pending'
			if (purchase.counted) return 'already-counted'
			if (purchase.bulkCouponId || purchase.redeemedBulkCouponId)
				return 'ineligible'
			if (['Refunded', 'Banned'].includes(purchase.status)) return 'ineligible'
			// The paid checkout adapter writes couponId with the purchase, not at settlement.
			if (!purchase.couponId) return 'ineligible'
			if (!purchase.paid || !activePurchaseStatuses.includes(purchase.status))
				return 'pending'

			const [row] = await tx
				.select({ id: coupon.id, maxUses: coupon.maxUses })
				.from(coupon)
				.where(eq(coupon.id, purchase.couponId))
				.for('update')
			if (!row) return 'pending'
			if (row.maxUses <= 0 || (await isTeamCoupon(tx, row.id)))
				return 'ineligible'
			if (
				purchase.fieldsType &&
				!['OBJECT', 'NULL'].includes(purchase.fieldsType)
			) {
				throw new Error('invalid-purchase-fields-for-coupon-accounting')
			}

			await tx
				.update(coupon)
				.set({ usedCount: sql`${coupon.usedCount} + 1` })
				.where(eq(coupon.id, row.id))
			await tx
				.update(purchases)
				.set({
					fields: sql`JSON_SET(
						CASE WHEN JSON_TYPE(${purchases.fields}) = 'OBJECT' THEN ${purchases.fields} ELSE JSON_OBJECT() END,
						'$.paidCouponUseCounted', true
					)`,
				})
				.where(eq(purchases.id, purchaseId))
			return 'counted'
		},
	)
}
