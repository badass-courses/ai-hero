import { db } from '@/db'
import type { ChargeState } from '@ai-hero/front-desk-support'
import { Effect, Layer } from 'effect'
import { integration } from '../support/integration'
import {
	PricingFactsSource,
	SourceUnavailable,
	type PricingPurchaseRow,
} from './pricing-facts'

const cents = (amount: unknown) => Math.round(Number(amount) * 100)
const attempt = <A>(
	source: SourceUnavailable['source'],
	run: () => Promise<A>,
) =>
	Effect.tryPromise({
		try: run,
		catch: () => new SourceUnavailable({ source }),
	})

/** SELECT-only reads plus the existing Stripe charge read. No writes. */
export const pricingFactsSourceLayer = (
	chargeState: (stripeChargeId: string) => Promise<ChargeState | null>,
) =>
	Layer.succeed(PricingFactsSource, {
		userByEmail: (email) =>
			attempt('user', async () => {
				const user = await integration.lookupUser(email)
				return user ? { id: user.id } : null
			}),
		purchases: (userId, productIds) =>
			attempt('purchases', async () => {
				const rows = await db.query.purchases.findMany({
					where: (purchase, { and, eq, inArray }) =>
						and(
							eq(purchase.userId, userId),
							inArray(purchase.productId, [...productIds]),
						),
					with: { bulkCoupon: true, merchantCharge: true },
					orderBy: (purchase, { asc }) => [asc(purchase.createdAt)],
				})
				return rows.map(
					(purchase): PricingPurchaseRow => ({
						id: purchase.id,
						productId: purchase.productId,
						status: purchase.status,
						bulkCouponId: purchase.bulkCouponId ?? null,
						redeemedBulkCouponId: purchase.redeemedBulkCouponId ?? null,
						bulkSeats: purchase.bulkCouponId
							? (purchase.bulkCoupon?.maxUses ?? null)
							: null,
						couponId: purchase.couponId ?? null,
						totalAmountCents: cents(purchase.totalAmount),
						stripeChargeId: purchase.merchantCharge?.identifier.startsWith(
							'ch_',
						)
							? purchase.merchantCharge.identifier
							: null,
					}),
				)
			}),
		couponTypes: (couponIds) =>
			attempt('coupons', async () => {
				const rows = await db.query.coupon.findMany({
					where: (row, { inArray }) => inArray(row.id, [...couponIds]),
					with: { merchantCoupon: true },
				})
				return new Map(
					rows.map((row) => [row.id, row.merchantCoupon?.type ?? null]),
				)
			}),
		activePrices: (productId) =>
			attempt('price', async () => {
				const rows = await db.query.prices.findMany({
					where: (price, { and, eq }) =>
						and(eq(price.productId, productId), eq(price.status, 1)),
				})
				return rows.map((price) => ({
					id: price.id,
					unitAmountCents: cents(price.unitAmount),
				}))
			}),
		chargeState: (stripeChargeId) =>
			attempt('charge', () => chargeState(stripeChargeId)),
	})
