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

/**
 * Reads the seat total out of a mysql2 `db.execute` result: the `[rows, fields]`
 * tuple (the pool also hangs `rows` on it, see `preserveQueryResultShape`).
 * A missing row or value throws. Defaulting to 0 would read as "no seats
 * taken" and keep a capped product on sale.
 */
export function parseSeatsTaken(result: unknown): number {
	const rows = Array.isArray(result)
		? result[0]
		: (result as { rows?: unknown } | null)?.rows
	const seats = (Array.isArray(rows) ? rows[0] : undefined)?.seats
	const total = Number(seats)
	if (seats === undefined || seats === null || !Number.isFinite(total))
		throw new Error('seats-taken query returned no usable total')
	return total
}

/** Seats taken for a capped product, summed in SQL. */
export async function getSeatsTaken(productId: string) {
	return parseSeatsTaken(await db.execute(seatsTakenSql(productId)))
}

/** Seats left on a capped product; never negative, so it cannot read as the -1 unlimited sentinel. */
export function seatsLeft(cap: number | null | undefined, taken: number) {
	return Math.max(0, (cap || 0) - taken)
}
