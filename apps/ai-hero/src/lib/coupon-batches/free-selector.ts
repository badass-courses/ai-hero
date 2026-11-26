import type { DbExecutor } from '@/db/client'
import { mysqlTable } from '@/db/mysql-table'
import { coupon } from '@/db/schema'
import { DrizzleAdapter } from '@coursebuilder/adapter-drizzle'
import type { CouponPort, PurchasePort } from '@coursebuilder/core/ports'
import { couponSchema } from '@coursebuilder/core/schemas'
import { and, eq, gt, sql } from 'drizzle-orm'
import type { MySqlDatabase } from 'drizzle-orm/mysql-core'

import { PRODUCT, TEMPLATE } from './contract'
import {
	activeCompClaimDigest,
	INTERNAL_COMP_CLAIM,
} from './free-claim-request'
import { inRowNamespace, inSelectorNamespace, selectorDigest } from './selector'

type BatchCouponDb = typeof import('@/db/client').db
type Paths = Pick<
	CouponPort,
	'getCoupon' | 'getCouponWithBulkPurchases' | 'couponForIdOrCode'
> &
	Pick<PurchasePort, 'redeemFullPriceCoupon'>
const reserved = (value: unknown) =>
	inRowNamespace(value) ||
	inSelectorNamespace(value) ||
	(typeof value === 'string' && value.toLowerCase().startsWith('c5hash_'))
const invalid = () => ({
	purchase: null,
	redeemingForCurrentUser: false,
	error: { message: 'coupon-is-invalid' },
})

function lookup(tx: DbExecutor, digest: string) {
	return tx
		.select()
		.from(coupon)
		.where(
			and(
				eq(coupon.code, digest),
				eq(coupon.restrictedToProductId, PRODUCT),
				eq(coupon.status, 1),
				eq(coupon.default, false),
				eq(coupon.maxUses, 1),
				eq(coupon.usedCount, 0),
				eq(coupon.percentageDiscount, '1.00'),
				gt(coupon.expires, sql`UTC_TIMESTAMP(3)`),
			),
		)
		.limit(1)
}

function isComp(row: typeof coupon.$inferSelect | undefined) {
	return (
		row &&
		inRowNamespace(row.id) &&
		row.fields?.couponBatchTemplate === TEMPLATE &&
		row.merchantCouponId === null &&
		row.organizationId === null
	)
}

/** Only the C5 free-claim page may present these coupons. The dialog carries
 * the original bearer in its existing `couponId` field; the real row ID is
 * not a redeemable value. Other product pages do not inherit the bypass. */
export function c5CompPresentation<T extends Pick<CouponPort, 'getCoupon'>>(
	adapter: T,
	db: BatchCouponDb,
	productId: string,
): T {
	if (productId !== PRODUCT) return adapter
	return {
		...adapter,
		async getCoupon(key: string) {
			if (!inSelectorNamespace(key)) return adapter.getCoupon(key)
			const digest = selectorDigest(key)
			if (!digest) return null
			try {
				const [row] = await lookup(db, digest)
				if (!isComp(row)) return null
				return couponSchema.parse({
					...row,
					id: key.toLowerCase(),
					code: null,
				})
			} catch {
				throw new Error('c5_comp_lookup_unavailable')
			}
		},
	}
}

/** Narrow free-redeem bridge; paid pricing and legacy selector behavior stay
 * on their existing paths. Resolve by digest only, then serialize the existing
 * CB free workflow on the coupon row in the same transaction. */
export function guardC5CompSelectors<T extends Paths>(
	adapter: T,
	db: BatchCouponDb,
): T {
	const redeem = adapter.redeemFullPriceCoupon.bind(adapter)
	const getCoupon = adapter.getCoupon.bind(adapter)
	const getBulk = adapter.getCouponWithBulkPurchases.bind(adapter)
	const lookupLegacy = adapter.couponForIdOrCode.bind(adapter)
	return Object.assign(adapter, {
		getCoupon: (value: string) =>
			reserved(value) ? Promise.resolve(null) : getCoupon(value),
		getCouponWithBulkPurchases: (value?: string) =>
			reserved(value) ? Promise.resolve(null) : getBulk(value),
		couponForIdOrCode: (
			input: Parameters<CouponPort['couponForIdOrCode']>[0],
		) =>
			reserved(input.code) || reserved(input.couponId)
				? Promise.resolve(null)
				: lookupLegacy(input),
		async redeemFullPriceCoupon(
			input: Parameters<PurchasePort['redeemFullPriceCoupon']>[0],
		) {
			if (!reserved(input.couponId)) return redeem(input)
			if (
				input.couponId !== INTERNAL_COMP_CLAIM ||
				input.redeemingProductId !== PRODUCT ||
				input.productIds?.length !== 1 ||
				input.productIds[0] !== PRODUCT
			)
				return invalid()
			const digest = activeCompClaimDigest()
			if (!digest) return invalid()
			try {
				return await db.transaction(async (tx) => {
					const [row] = await lookup(tx, digest).for('update')
					if (!row || !isComp(row)) return invalid()
					const txAdapter = DrizzleAdapter<MySqlDatabase<any, any, any>>(
						tx,
						mysqlTable,
					)
					return (
						(await txAdapter.redeemFullPriceCoupon({
							...input,
							couponId: row.id,
						})) ?? invalid()
					)
				})
			} catch {
				throw new Error('c5_comp_redeem_unavailable')
			}
		},
	})
}
