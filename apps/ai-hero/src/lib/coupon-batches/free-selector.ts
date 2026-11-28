import 'server-only'
import type { DbExecutor } from '@/db/client'
import { coupon, couponBatchControl, purchases } from '@/db/schema'
import { SEAT_HOLDING_STATUSES } from '@/lib/pricing-decisions'
import { log } from '@/server/logger'
import type { PurchasePort } from '@coursebuilder/core/ports'
import { createPersonalOrganizationService } from '@coursebuilder/organizations'
import { and, eq, getTableColumns, inArray, isNull, sql } from 'drizzle-orm'

import {
	CLAIM_CONTROL_ID,
	PRODUCT,
	TEMPLATE,
	inRowNamespace,
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

async function claimsEnabled(tx: DbExecutor, lock = false) {
	if (process.env.AIH_COUPON_BATCH_ENABLED !== 'true') return false
	const query = tx
		.select({ enabled: couponBatchControl.claimsEnabled })
		.from(couponBatchControl)
		.where(eq(couponBatchControl.id, CLAIM_CONTROL_ID))
	const [row] = lock ? await query.for('share') : await query
	return row?.enabled === 1
}

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
				sql`BINARY ${coupon.code} = BINARY ${digest}`,
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

export async function c5CompAvailable(db: BatchCouponDb, code: string) {
	const digest = selectorDigest(code)
	if (!digest) return false
	try {
		if (!(await claimsEnabled(db))) return false
		const [row] = await lookup(db, digest)
		return Boolean(isComp(row))
	} catch {
		throw new Error('c5_comp_lookup_unavailable')
	}
}

/** The coupon row is locked on the normal app connection for the whole claim. */
export async function redeemPrivateComp(
	db: BatchCouponDb,
	input: Parameters<PurchasePort['redeemFullPriceCoupon']>[0],
	adapterFor: (
		executor: DbExecutor,
	) => Parameters<
		typeof createPersonalOrganizationService
	>[0]['organizations'] &
		Pick<PurchasePort, 'redeemFullPriceCoupon'> &
		Pick<import('@coursebuilder/core/ports').IdentityPort, 'findOrCreateUser'>,
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
		if (process.env.AIH_COUPON_BATCH_ENABLED !== 'true') return invalid()
		return await db.transaction(async (tx) => {
			if (!(await claimsEnabled(tx, true))) return invalid()
			const [row] = await lookup(tx, digest).for('update')
			if (!row || !isComp(row)) return invalid()
			const txAdapter = adapterFor(tx)
			// Provision atomically: a losing or rolled-back claim creates no user or org.
			const { user, isNewUser } = await txAdapter.findOrCreateUser(input.email)
			const alreadyOwned = {
				purchase: null,
				redeemingForCurrentUser: input.currentUserId === user.id,
				error: { message: 'already-purchased-c5' },
			}
			if (!isNewUser) {
				// Check all seat-holding statuses without hydrating legacy purchases.
				const [owned] = await tx
					.select({ id: purchases.id })
					.from(purchases)
					.where(
						and(
							eq(purchases.userId, user.id),
							eq(purchases.productId, PRODUCT),
							inArray(purchases.status, [...SEAT_HOLDING_STATUSES]),
							isNull(purchases.bulkCouponId),
						),
					)
					.limit(1)
				if (owned) return alreadyOwned
			}
			if (isNewUser) {
				await createPersonalOrganizationService({
					organizations: txAdapter,
					logger: log,
				}).ensurePersonalOrganization(user)
			}
			const result = await txAdapter.redeemFullPriceCoupon({
				...input,
				couponId: row.id,
			})
			if (isNewUser && !result?.purchase) throw rollbackFirstClaim
			// Keep the dialog's refusal prefix without echoing the claimant email.
			if (result?.error?.message.startsWith('already-purchased-'))
				return alreadyOwned
			return result ?? invalid()
		})
	} catch (error) {
		if (error === rollbackFirstClaim) return invalid()
		throw new Error('c5_comp_redeem_unavailable')
	}
}
