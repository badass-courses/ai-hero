import { db } from '@/db'
import { coupon, purchases } from '@/db/schema'
import { eq } from 'drizzle-orm'

import { seatsTaken } from './pricing-decisions'

/** Seats taken for a capped product, by the one `seatsTaken` rule. */
export async function getSeatsTaken(productId: string) {
	const rows = await db
		.select({
			status: purchases.status,
			bulkCouponId: purchases.bulkCouponId,
			bulkCouponMaxUses: coupon.maxUses,
		})
		.from(purchases)
		.leftJoin(coupon, eq(coupon.id, purchases.bulkCouponId))
		.where(eq(purchases.productId, productId))
	return seatsTaken(rows)
}
