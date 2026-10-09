import { db } from '@/db'
import type { ChargeState } from '@ai-hero/front-desk-support'
import { Effect, Layer } from 'effect'
import type Stripe from 'stripe'
import { integration } from '../support/integration'
import {
	PricingFactsSource,
	SourceUnavailable,
	type PricingPurchaseRow,
	type PricingSettlement,
} from './pricing-facts'

/** The read-only Stripe calls the pricing source makes. */
export interface PricingStripeReads {
	readonly charges: Pick<Stripe['charges'], 'retrieve'>
	readonly checkout: {
		readonly sessions: Pick<
			Stripe['checkout']['sessions'],
			'retrieve' | 'listLineItems'
		>
	}
}

const cents = (amount: unknown) => Math.round(Number(amount) * 100)
const attempt = <A>(
	source: SourceUnavailable['source'],
	run: () => Promise<A>,
) =>
	Effect.tryPromise({
		try: run,
		catch: () => new SourceUnavailable({ source }),
	})
const missing = (error: unknown) =>
	typeof error === 'object' &&
	error !== null &&
	'code' in error &&
	error.code === 'resource_missing'
const idOf = (value: string | { id: string } | null | undefined) =>
	typeof value === 'string' ? value : (value?.id ?? null)

/** SELECT-only reads plus Stripe retrieve and list calls. No writes. */
export const pricingFactsSourceLayer = (deps: {
	readonly chargeState: (stripeChargeId: string) => Promise<ChargeState | null>
	readonly stripe: PricingStripeReads
}) =>
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
					with: {
						bulkCoupon: true,
						merchantCharge: { with: { merchantProduct: true } },
						merchantSession: true,
					},
					orderBy: (purchase, { asc }) => [asc(purchase.createdAt)],
				})
				return rows.map((purchase): PricingPurchaseRow => {
					const charge = purchase.merchantCharge
					const merchantProduct = charge?.merchantProduct
					const session = purchase.merchantSession?.identifier
					return {
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
						stripeChargeId: charge?.identifier.startsWith('ch_')
							? charge.identifier
							: null,
						checkoutSessionId: session?.startsWith('cs_') ? session : null,
						stripeProductId:
							merchantProduct?.productId === purchase.productId &&
							merchantProduct.identifier?.startsWith('prod_')
								? merchantProduct.identifier
								: null,
					}
				})
			}),
		couponTypes: (couponIds) =>
			attempt('coupons', async () => {
				const rows = await db.query.coupon.findMany({
					where: (row, { inArray }) => inArray(row.id, [...couponIds]),
					with: { merchantCoupon: true },
				})
				return new Map(
					rows.map((row) => [row.id, row.merchantCoupon?.type || null]),
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
		settlement: ({ stripeChargeId, checkoutSessionId }) =>
			attempt('settlement', async (): Promise<PricingSettlement | null> => {
				// Refund count and dispute come from the support read's own path.
				const state = await deps.chargeState(stripeChargeId)
				if (!state) return null
				const charge = await deps.stripe.charges.retrieve(stripeChargeId)
				let session: Stripe.Checkout.Session | null = null
				try {
					session =
						await deps.stripe.checkout.sessions.retrieve(checkoutSessionId)
				} catch (error) {
					if (!missing(error)) throw error
				}
				const lines = session
					? await deps.stripe.checkout.sessions.listLineItems(session.id, {
							limit: 100,
						})
					: null
				return {
					charge: {
						id: charge.id,
						amount: charge.amount,
						currency: charge.currency,
						paid: charge.paid,
						captured: charge.captured,
						status: charge.status,
						amountRefunded: state.amountRefunded,
						refundCount: state.refundCount,
						disputed: state.disputed,
						paymentIntentId: idOf(charge.payment_intent),
					},
					session:
						session && lines
							? {
									id: session.id,
									status: session.status,
									paymentStatus: session.payment_status,
									paymentIntentId: idOf(session.payment_intent),
									linesComplete: !lines.has_more,
									lines: lines.data.map((line) => ({
										stripeProductId: idOf(line.price?.product),
										quantity: line.quantity,
										currency: line.currency,
										amountTotal: line.amount_total,
										amountTax: line.amount_tax,
									})),
								}
							: null,
				}
			}),
	})
