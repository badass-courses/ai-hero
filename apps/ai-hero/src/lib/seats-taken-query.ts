import { db } from '@/db'
import { coupon, purchases } from '@/db/schema'
import { sql } from 'drizzle-orm'

import { SEAT_HOLDING_STATUSES } from './pricing-decisions'

const holding = sql.join(
	SEAT_HOLDING_STATUSES.map((status) => sql`${status}`),
	sql`, `,
)

/**
 * The SQL form of `seatsTaken` in `pricing-decisions.ts` (see that function
 * for the rule; `seats-taken-query.mysql.test.ts` holds the two to parity).
 */
export function seatsTakenSql(productId: string) {
	return sql`
		select
			(
				select coalesce(sum(greatest(coalesce(c.maxUses, 1), 1)), 0)
				from (
					select distinct p.bulkCouponId as id
					from ${purchases} p
					where p.productId = ${productId}
						and p.status in (${holding})
						and p.bulkCouponId is not null
				) b
				left join ${coupon} c on c.id = b.id
			) + (
				select count(*)
				from ${purchases} p
				where p.productId = ${productId}
					and p.status in (${holding})
					and p.bulkCouponId is null
					and (
						p.redeemedBulkCouponId is null
						or p.redeemedBulkCouponId not in (
							select q.bulkCouponId
							from ${purchases} q
							where q.productId = ${productId}
								and q.status in (${holding})
								and q.bulkCouponId is not null
						)
					)
			) as seats
	`
}

/** Seats taken for a capped product, summed in SQL. */
export async function getSeatsTaken(productId: string) {
	const result = (await db.execute(seatsTakenSql(productId))) as unknown as {
		rows?: { seats?: unknown }[]
	}
	return Number(result.rows?.[0]?.seats ?? 0)
}
