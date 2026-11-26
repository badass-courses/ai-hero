import type { DbExecutor } from '@/db/client'
import { coupon, purchases } from '@/db/schema'
import { and, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm'

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
>(adapter: T, db: DbExecutor): T {
	const getCoupon = adapter.getCoupon.bind(adapter)
	const couponForIdOrCode = adapter.couponForIdOrCode.bind(adapter)
	const getDefaultCoupon = adapter.getDefaultCoupon.bind(adapter)
	return Object.assign(adapter, {
		getCoupon: async (key: string) => {
			const row = await getCoupon(key)
			if (!row) return null
			const effective = await withEffectivePaidCouponUsage(db, row)
			// The legacy formatter also reads entitlement coupons with getCoupon,
			// but doesn't check usedCount there. Do not expose a discount source.
			return effective.paidCouponUsedUp
				? { ...effective, merchantCouponId: null }
				: effective
		},
		couponForIdOrCode: async (input: Parameters<T['couponForIdOrCode']>[0]) => {
			const row = await couponForIdOrCode(input)
			return row && withEffectivePaidCouponUsage(db, row)
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
		async (tx): Promise<'counted' | 'already-counted' | 'ineligible'> => {
			const [purchase] = await tx
				.select({
					couponId: purchases.couponId,
					counted: sql<number>`JSON_CONTAINS_PATH(${purchases.fields}, 'one', '$.paidCouponUseCounted')`,
					fieldsType: sql<string | null>`JSON_TYPE(${purchases.fields})`,
				})
				.from(purchases)
				.where(
					and(
						eq(purchases.id, purchaseId),
						inArray(purchases.status, activePurchaseStatuses),
						isNull(purchases.bulkCouponId),
						isNull(purchases.redeemedBulkCouponId),
						isNotNull(purchases.merchantChargeId),
						sql`${purchases.totalAmount} > 0`,
					),
				)
				.for('update')
			if (!purchase?.couponId) return 'ineligible'
			if (purchase.counted) return 'already-counted'

			const [row] = await tx
				.select({ id: coupon.id, maxUses: coupon.maxUses })
				.from(coupon)
				.where(eq(coupon.id, purchase.couponId))
				.for('update')
			if (!row || row.maxUses <= 0 || (await isTeamCoupon(tx, row.id)))
				return 'ineligible'
			if (purchase.fieldsType && !['OBJECT', 'NULL'].includes(purchase.fieldsType)) {
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
