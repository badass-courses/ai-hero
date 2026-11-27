import 'server-only'
import type { DbExecutor } from '@/db/client'
import { mysqlTable } from '@/db/mysql-table'
import { coupon } from '@/db/schema'
import { cloneAdapter } from '@/lib/paid-coupon-pricing-view'
import { DrizzleAdapter } from '@coursebuilder/adapter-drizzle'
import type { CouponPort, PurchasePort } from '@coursebuilder/core/ports'
import { couponSchema } from '@coursebuilder/core/schemas'
import { createPersonalOrganizationService } from '@coursebuilder/organizations'
import { and, eq, getTableColumns, sql } from 'drizzle-orm'
import type { MySqlDatabase } from 'drizzle-orm/mysql-core'

import {
	PRODUCT,
	TEMPLATE,
	inRowNamespace,
	inSelectorNamespace,
} from './namespace'
import {
	activeCompClaimDigest,
	INTERNAL_COMP_CLAIM,
} from './free-claim-request'
import { selectorDigest } from './selector'

type BatchCouponDb = typeof import('@/db/client').db
const rollbackFirstClaim = Symbol('rollbackFirstClaim')
const invalid = () => ({
	purchase: null,
	redeemingForCurrentUser: false,
	error: { message: 'coupon-is-invalid' },
})

function lookup(tx: DbExecutor, digest: string) {
	return tx
		.select({
			...getTableColumns(coupon),
			expires: sql<Date>`UNIX_TIMESTAMP(${coupon.expires})`.mapWith({
				mapFromDriverValue: (seconds: unknown) =>
					new Date(Number(seconds) * 1000),
			}),
		})
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
				sql`UNIX_TIMESTAMP(${coupon.expires}) > UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3))`,
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
export function c5CompPresentation<
	T extends Pick<CouponPort, 'getCoupon'> & {
		getCouponForDisplay?: CouponPort['getCoupon']
	},
>(adapter: T, db: BatchCouponDb, productId: string): T {
	if (productId !== PRODUCT) return adapter
	const display = async (key: string) => {
		if (inRowNamespace(key)) return null
		if (!inSelectorNamespace(key))
			return (adapter.getCouponForDisplay ?? adapter.getCoupon).call(
				adapter,
				key,
			)
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
	}
	return Object.assign(cloneAdapter(adapter), {
		getCoupon: display,
		getCouponForDisplay: display,
	})
}

/** The coupon row is locked on the normal app connection for the whole claim. */
export async function redeemPrivateComp(
	db: BatchCouponDb,
	input: Parameters<PurchasePort['redeemFullPriceCoupon']>[0],
) {
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
			// Provision atomically: a losing or rolled-back claim creates no user or org.
			const { user, isNewUser } = await txAdapter.findOrCreateUser(input.email)
			if (isNewUser) {
				await createPersonalOrganizationService({
					organizations: txAdapter,
					logger: { info: () => {}, error: () => {} },
				}).ensurePersonalOrganization(user)
			}
			const result = await txAdapter.redeemFullPriceCoupon({
				...input,
				couponId: row.id,
			})
			if (isNewUser && !result?.purchase) throw rollbackFirstClaim
			return result ?? invalid()
		})
	} catch (error) {
		if (error === rollbackFirstClaim) return invalid()
		throw new Error('c5_comp_redeem_unavailable')
	}
}
