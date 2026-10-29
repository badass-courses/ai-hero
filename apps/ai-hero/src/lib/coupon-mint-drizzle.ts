import { db } from '@/db'
import { coupon, products } from '@/db/schema'
import { and, desc, eq, sql } from 'drizzle-orm'

import type { CouponMintStore, StoredCoupon } from './coupon-mint'

const storedCouponColumns = {
	id: coupon.id,
	restrictedToProductId: coupon.restrictedToProductId,
	percentageDiscount: coupon.percentageDiscount,
	maxUses: coupon.maxUses,
	usedCount: coupon.usedCount,
	expires: coupon.expires,
	merchantCouponId: coupon.merchantCouponId,
	status: coupon.status,
	fields: coupon.fields,
	createdAt: coupon.createdAt,
}

export const drizzleCouponMintStore: CouponMintStore = {
	async findProduct(id) {
		const [row] = await db
			.select({ id: products.id, name: products.name })
			.from(products)
			.where(eq(products.id, id))
			.limit(1)
		return row ?? null
	},
	async findCouponsByMintKey(mintKey) {
		// Unindexed JSON match; fine for an admin-only mint endpoint.
		return (await db
			.select(storedCouponColumns)
			.from(coupon)
			.where(
				sql`JSON_UNQUOTE(JSON_EXTRACT(${coupon.fields}, '$.mintKey')) = ${mintKey}`,
			)) as StoredCoupon[]
	},
	async insertCoupons(rows) {
		await db.transaction(async (trx) => {
			await trx.insert(coupon).values(rows)
		})
	},
	async listCoupons({ productId, label, limit }) {
		return (await db
			.select(storedCouponColumns)
			.from(coupon)
			.where(
				and(
					eq(coupon.restrictedToProductId, productId),
					label
						? sql`JSON_UNQUOTE(JSON_EXTRACT(${coupon.fields}, '$.mintedFor')) = ${label}`
						: undefined,
				),
			)
			.orderBy(desc(coupon.createdAt), coupon.id)
			.limit(limit)) as StoredCoupon[]
	},
}
