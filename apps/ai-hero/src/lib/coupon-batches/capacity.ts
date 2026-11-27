import { coupon, purchases } from '@/db/schema'
import { sql } from 'drizzle-orm'

import { PRODUCT, ROW_PREFIX, TEMPLATE } from './namespace'

export const excludeC5CompsFromCapacity = (productId: string) =>
	productId === PRODUCT && process.env.AIH_COUPON_BATCH_ENABLED === 'true'

/** Keep every purchase except a direct, uncharged $0 claim linked to the
 * stored C5 batch template. Team parents and redeemed team seats still count. */
export function capacityPurchaseFilter(productId: string, alias?: 'p') {
	if (!excludeC5CompsFromCapacity(productId)) return undefined
	const column = (
		key:
			| 'couponId'
			| 'totalAmount'
			| 'merchantChargeId'
			| 'bulkCouponId'
			| 'redeemedBulkCouponId',
	) =>
		alias
			? sql`${sql.identifier(alias)}.${sql.identifier(key)}`
			: purchases[key]
	return sql`not exists (
		select 1 from ${coupon} capacity_comp
		where capacity_comp.id = ${column('couponId')}
			and capacity_comp.id like ${`${ROW_PREFIX}%`}
			and capacity_comp.restrictedToProductId = ${PRODUCT}
			and capacity_comp.merchantCouponId is null
			and json_unquote(json_extract(capacity_comp.fields, '$.couponBatchTemplate')) = ${TEMPLATE}
			and ${column('totalAmount')} = 0
			and ${column('merchantChargeId')} is null
			and ${column('bulkCouponId')} is null
			and ${column('redeemedBulkCouponId')} is null
	)`
}
