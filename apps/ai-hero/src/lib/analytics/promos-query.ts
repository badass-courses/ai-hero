import { sql } from 'drizzle-orm'
import type { PromoOptions, PromoRevenue } from './promos'

/** Only grouped, anonymous rows leave MySQL. Purchases store USD major units. */
export function promoRevenueSql(
	options: PromoOptions,
	window: PromoRevenue['window'],
) {
	const kind = sql`CASE
		WHEN p.totalAmount = 0 OR p.redeemedBulkCouponId IS NOT NULL THEN 'seat-or-zero'
		WHEN p.totalAmount IS NULL OR p.totalAmount < 0 OR p.status IS NULL OR BINARY p.status NOT IN ('Valid', 'Restricted', 'Refunded') THEN 'unclassified'
		WHEN c.id IS NOT NULL AND JSON_CONTAINS_PATH(c.fields, 'one', '$.evergreenOffer') = 1 THEN 'evergreen'
		WHEN BINARY p.status = 'Restricted' OR BINARY m.type = 'ppp' OR BINARY bm.type = 'ppp' THEN 'regional'
		WHEN p.couponId IS NOT NULL AND c.id IS NULL AND m.id IS NULL THEN 'unclassified'
		WHEN p.couponId IS NOT NULL OR bm.id IS NOT NULL THEN 'other-coupon'
		ELSE 'full-price' END`
	const paid = sql`p.totalAmount > 0 AND p.redeemedBulkCouponId IS NULL AND BINARY p.status IN ('Valid', 'Restricted', 'Refunded')`
	// FROM_UNIXTIME compares TIMESTAMP values in the connection's timezone;
	// epoch arithmetic builds UTC dates without relying on timezone tables.
	const date = sql`DATE_FORMAT(TIMESTAMPADD(SECOND, FLOOR(UNIX_TIMESTAMP(p.createdAt)), '1970-01-01'), '%Y-%m-%d')`
	return sql`SELECT ${date} AS date, ${kind} AS kind,
		COUNT(*) AS recordCount,
		SUM(CASE WHEN ${paid} THEN 1 ELSE 0 END) AS purchaseCount,
		SUM(CASE WHEN ${paid} THEN p.totalAmount ELSE 0 END) AS gross,
		SUM(CASE WHEN ${paid} AND BINARY p.status = 'Refunded' THEN p.totalAmount ELSE 0 END) AS refunds
		FROM AI_Purchase p
		LEFT JOIN AI_Coupon c ON c.id = p.couponId
		LEFT JOIN AI_MerchantCoupon m ON m.id = COALESCE(c.merchantCouponId, p.couponId)
		LEFT JOIN AI_Coupon bc ON bc.id = p.bulkCouponId
		LEFT JOIN AI_MerchantCoupon bm ON bm.id = bc.merchantCouponId
		WHERE p.createdAt < FROM_UNIXTIME(${Date.parse(window.to)} / 1000)
		${window.from ? sql`AND p.createdAt >= FROM_UNIXTIME(${Date.parse(window.from)} / 1000)` : sql``}
		${options.productId ? sql`AND p.productId = ${options.productId}` : sql``}
		GROUP BY date, kind ORDER BY date, kind`
}
