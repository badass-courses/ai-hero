import {
	contact,
	coupon,
	entitlements,
	entitlementTypes,
	merchantCoupon,
	users,
} from '@/db/schema'
import { and, eq } from 'drizzle-orm'
import type { MySql2Database } from 'drizzle-orm/mysql2'

import {
	CouponAuthorityFailure,
	refuseCoupon,
	type CouponCommerceStore,
} from './coupon-authority'
import type { CouponReceiptReadStore } from './coupon-receipt-reader'

export const couponCommerceSchema = {
	contact,
	coupon,
	entitlements,
	entitlementTypes,
	merchantCoupon,
	users,
}
export type CouponCommerceDatabase = MySql2Database<typeof couponCommerceSchema>

/** No default/global connection. All operations below share one rollback boundary. */
export function createMySqlCouponCommerceStore(
	database: CouponCommerceDatabase,
): CouponCommerceStore {
	return {
		withContactLock: async (contactId, work) => {
			let callbackFailure: unknown
			try {
				return await database.transaction(async (tx) => {
					try {
						// Existing PK row serializes issue/bind, including the initially absent coupon.
						const owner = await tx
							.select({ id: contact.id })
							.from(contact)
							.where(eq(contact.id, contactId))
							.for('update')
						if (owner.length !== 1) return refuseCoupon('contact-not-found')
						return await work({
							getMerchantCoupon: async (id) =>
								(
									await tx
										.select()
										.from(merchantCoupon)
										.where(eq(merchantCoupon.id, id))
										.for('update')
								)[0] ?? null,
							getCoupon: async (id) =>
								(
									await tx
										.select()
										.from(coupon)
										.where(eq(coupon.id, id))
										.for('update')
								)[0] ?? null,
							insertCoupon: async (row) => {
								await tx.insert(coupon).values(row)
							},
							setCouponFields: async (id, fields) => {
								await tx.update(coupon).set({ fields }).where(eq(coupon.id, id))
							},
							getUser: async (id) =>
								(
									await tx
										.select()
										.from(users)
										.where(eq(users.id, id))
										.for('update')
								)[0] ?? null,
							getCreditTypeId: async () =>
								(
									await tx
										.select({ id: entitlementTypes.id })
										.from(entitlementTypes)
										.where(eq(entitlementTypes.name, 'apply_special_credit'))
								)[0]?.id ?? null,
							listCouponEntitlements: async (id) =>
								tx
									.select()
									.from(entitlements)
									.where(
										and(
											eq(entitlements.sourceType, 'COUPON'),
											eq(entitlements.sourceId, id),
										),
									)
									.for('update'),
							insertEntitlement: async (row) => {
								await tx.insert(entitlements).values(row)
							},
						})
					} catch (cause) {
						callbackFailure = cause
						throw cause
					}
				})
			} catch (cause) {
				// Installed Drizzle mysql2/session: awaits ROLLBACK, then rethrows the
				// SAME callback error. Commit/rollback failures cannot satisfy this identity.
				// 1205 alone is statement rollback, not proof of transaction rollback.
				if (
					cause === callbackFailure &&
					cause instanceof Error &&
					'errno' in cause &&
					'code' in cause &&
					((cause.errno === 1205 && cause.code === 'ER_LOCK_WAIT_TIMEOUT') ||
						(cause.errno === 1213 && cause.code === 'ER_LOCK_DEADLOCK'))
				) {
					throw new CouponAuthorityFailure({
						type: 'EffectTransientUnavailable',
						reason: 'commerce-transaction-rolled-back',
					})
				}
				throw cause
			}
		},
	}
}

/** SELECT-only capability. Does not enter the write transaction or lock contact rows. */
export function createMySqlCouponReceiptReadStore(
	database: CouponCommerceDatabase,
): CouponReceiptReadStore {
	return {
		getCoupon: async (id) =>
			(await database.select().from(coupon).where(eq(coupon.id, id)))[0] ??
			null,
		getCreditTypeId: async () =>
			(
				await database
					.select({ id: entitlementTypes.id })
					.from(entitlementTypes)
					.where(eq(entitlementTypes.name, 'apply_special_credit'))
			)[0]?.id ?? null,
		listCouponEntitlements: async (id) =>
			database
				.select()
				.from(entitlements)
				.where(
					and(
						eq(entitlements.sourceType, 'COUPON'),
						eq(entitlements.sourceId, id),
					),
				),
	}
}
