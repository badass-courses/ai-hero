import { courseBuilderAdapter, db } from '@/db'
import { entitlements, merchantCharge } from '@/db/schema'
import { stripeProvider } from '@/coursebuilder/stripe-provider'
import { StripePaymentAdapter } from '@coursebuilder/commerce/stripe-provider'
import { and, eq, gt, isNull, or, sql } from 'drizzle-orm'
import {
	checkPurchaseInvariants,
	purchaseInvariantChecks,
	purchaseDecisionInvariantChecks,
} from './invariants'
import type { BuyPathContext } from './schema'
import { emitBuyPath } from './server'

/** Read fresh rows, never reuse the workflow's earlier purchase object. */
export async function verifyPurchase(
	context: BuyPathContext,
	expectedEntitlementCount: number,
) {
	const started = Date.now()
	const purchase = context.purchaseId
		? await courseBuilderAdapter
				.getPurchase(context.purchaseId)
				.catch(async () => {
					await emitBuyPath(context, 'invariant_failed', {
						outcome: 'failed',
						field: 'purchase',
					})
					return null
				})
		: null
	const access = purchase
		? await db
				.select({ id: entitlements.id })
				.from(entitlements)
				.where(
					and(
						eq(entitlements.sourceId, purchase.id),
						eq(entitlements.userId, purchase.userId ?? ''),
						isNull(entitlements.deletedAt),
						or(
							isNull(entitlements.expiresAt),
							gt(entitlements.expiresAt, sql`CURRENT_TIMESTAMP`),
						),
					),
				)
				.catch(async () => {
					await emitBuyPath(context, 'invariant_failed', {
						outcome: 'failed',
						field: 'entitlements',
					})
					return []
				})
		: []
	const charge = purchase?.merchantChargeId
		? await db.query.merchantCharge
				.findFirst({ where: eq(merchantCharge.id, purchase.merchantChargeId) })
				.catch(() => null)
		: null
	const stripe = (
		stripeProvider.options.paymentsAdapter as StripePaymentAdapter
	).stripe
	const payment = charge?.identifier
		? await stripe.charges.retrieve(charge.identifier).catch(() => null)
		: null
	const verifiedContext = {
		...context,
		paymentAt: payment ? payment.created * 1000 : null,
		chargeId: charge?.identifier ?? null,
	}
	const failures = await checkPurchaseInvariants(
		{
			buyPathId: context.buyPathId,
			purchaseId: context.purchaseId,
			productId: purchase?.productId ?? context.productId,
			userId: purchase?.userId ?? context.userId,
			exists: Boolean(purchase),
			status: purchase?.status ?? null,
			entitlementCount: access.length,
			expectedEntitlementCount,
			totalCents: purchase
				? Math.round(Number(purchase.totalAmount) * 100)
				: null,
			chargeCents: payment?.amount ?? null,
			requiresCharge: Boolean(purchase && !purchase.redeemedBulkCouponId),
		},
		[...purchaseInvariantChecks, ...purchaseDecisionInvariantChecks],
		async (field) => {
			await emitBuyPath(verifiedContext, 'invariant_failed', {
				outcome: 'failed',
				field,
			})
		},
	)
	await emitBuyPath(verifiedContext, 'entitlements_granted', {
		outcome:
			expectedEntitlementCount === 0
				? 'skipped'
				: access.length >= expectedEntitlementCount
					? 'ok'
					: 'failed',
	})
	// Decision is explicitly skipped until the desk installs the new-table adapter.
	if (!purchaseDecisionInvariantChecks.length)
		await emitBuyPath(verifiedContext, 'invariant_checked', {
			outcome: 'skipped',
			field: 'decision',
		})
	await emitBuyPath(verifiedContext, 'invariant_checked', {
		outcome: failures.length ? 'failed' : 'ok',
		durationMs: Date.now() - started,
	})
	return {
		failures,
		decisionChecked: purchaseDecisionInvariantChecks.length > 0,
	}
}
