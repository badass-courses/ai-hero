import { db } from '@/db'
import { decisionFromRow } from '@/lib/c5-pricing/purchase-decision-sql'
import { drizzleC5DecisionStore } from '@/lib/c5-pricing/purchase-decision-store'
import type { ChargeState } from '@ai-hero/front-desk-support'
import { Effect, Layer } from 'effect'
import type Stripe from 'stripe'
import { integration } from '../support/integration'
import {
	PricingFactsSource,
	SourceUnavailable,
	type CreditChainTarget,
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
	/** When paid target purchases started saving decisions. */
	readonly decisionCutover: Date | null
}) =>
	Layer.succeed(PricingFactsSource, {
		userByEmail: (email) =>
			attempt('user', async () => {
				const user = await integration.lookupUser(email)
				return user ? { id: user.id } : null
			}),
		purchases: (userId, productIds) =>
			attempt('purchases', async () => {
				// Current owner only. Transfer history must not restore purchases
				// transferred out, and an unaccepted transfer offer changes nothing.
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
		creditChain: ({ creditSource, productId }) =>
			attempt('transfers', async () => {
				const sourcePurchase = await db.query.purchases.findFirst({
					where: (purchase, { eq }) => eq(purchase.id, creditSource),
					columns: { userId: true },
				})
				if (!sourcePurchase?.userId) throw new Error('credit source unreadable')
				// Each transfer's source owned the purchase when the row was made; a
				// target only held it once the transfer completed.
				const moves = await db.query.purchaseUserTransfer.findMany({
					where: (transfer, { eq }) => eq(transfer.purchaseId, creditSource),
				})
				const holders = [
					...new Set([
						sourcePurchase.userId,
						...moves.flatMap((move) => [
							move.sourceUserId,
							...(move.transferState === 'COMPLETED' && move.targetUserId
								? [move.targetUserId]
								: []),
						]),
					]),
				]
				const [held, movedAway] = await Promise.all([
					db.query.purchases.findMany({
						where: (purchase, { and, eq, inArray }) =>
							and(
								inArray(purchase.userId, holders),
								eq(purchase.productId, productId),
							),
					}),
					db.query.purchaseUserTransfer.findMany({
						where: (transfer, { inArray }) =>
							inArray(transfer.sourceUserId, holders),
						with: { purchase: true },
					}),
				])
				const targetIds = [
					...new Set([
						...held.map((row) => row.id),
						...movedAway.flatMap((move) =>
							move.purchase ? [move.purchase.id] : [],
						),
					]),
				]
				const decisions = targetIds.length
					? await db.query.purchaseDecision.findMany({
							where: (row, { inArray }) => inArray(row.purchaseId, targetIds),
						})
					: []
				const savedIds = new Set(
					decisions
						.filter((row) => decisionFromRow(row) !== null)
						.map((row) => row.purchaseId),
				)
				const targets = new Map<string, CreditChainTarget>()
				const add = (purchase: (typeof held)[number]) => {
					if (purchase.productId !== productId) return
					if (!(purchase.createdAt instanceof Date))
						throw new Error('target purchase unreadable')
					targets.set(purchase.id, {
						id: purchase.id,
						createdAt: purchase.createdAt,
						bulkCouponId: purchase.bulkCouponId ?? null,
						redeemedBulkCouponId: purchase.redeemedBulkCouponId ?? null,
						hasSavedDecision: savedIds.has(purchase.id),
					})
				}
				for (const purchase of held) add(purchase)
				for (const move of movedAway) {
					// A transferred purchase that cannot be read could be a target one.
					if (!move.purchase) throw new Error('transferred purchase unreadable')
					add(move.purchase)
				}
				return { holders, targets: [...targets.values()] }
			}),
		decisionCutover: deps.decisionCutover,
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
		creditSpentBy: (creditSource) =>
			attempt('ledger', () => drizzleC5DecisionStore().spentBy(creditSource)),
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
				// Two reads of the charge: the support read (with paginated refunds)
				// and a retrieve for settlement fields. Refund and dispute evidence
				// from either one counts, so a change between them is never lost.
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
						amountRefunded: Math.max(
							state.amountRefunded,
							charge.amount_refunded,
							charge.refunded ? charge.amount : 0,
						),
						refundCount: Math.max(
							state.refundCount,
							charge.amount_refunded > 0 || charge.refunded ? 1 : 0,
						),
						disputed: state.disputed || charge.disputed,
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
