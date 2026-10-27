import { courseBuilderAdapter, db } from '@/db'
import { merchantCharge, merchantSession } from '@/db/schema'
import { stripeProvider } from '@/coursebuilder/stripe-provider'
import { StripePaymentAdapter } from '@coursebuilder/commerce/stripe-provider'
import { eq } from 'drizzle-orm'
import type { BuyPathContext } from './schema'

export type PurchaseBuyPathRead =
	| { reason: 'checkout'; context: BuyPathContext }
	| { reason: 'missing-charge'; context: BuyPathContext }
	| { reason: 'no-merchant-session' | 'not-checkout-session'; context: null }
	| { reason: 'threw'; context: null; error: unknown }

/** Classify telemetry gaps without turning supported purchase paths into errors. */
export async function readPurchaseBuyPathContext(
	purchaseId: string,
): Promise<PurchaseBuyPathRead> {
	try {
		const purchase = await courseBuilderAdapter.getPurchase(purchaseId)
		if (!purchase?.merchantSessionId)
			return { reason: 'no-merchant-session', context: null }
		const session = await db.query.merchantSession.findFirst({
			where: eq(merchantSession.id, purchase.merchantSessionId),
		})
		if (!session?.identifier?.startsWith('cs_'))
			return { reason: 'not-checkout-session', context: null }
		const charge = purchase.merchantChargeId
			? await db.query.merchantCharge.findFirst({
					where: eq(merchantCharge.id, purchase.merchantChargeId),
				})
			: null
		const stripe = (
			stripeProvider.options.paymentsAdapter as StripePaymentAdapter
		).stripe
		const payment = charge?.identifier
			? await stripe.charges.retrieve(charge.identifier)
			: null
		return {
			reason: payment ? 'checkout' : 'missing-charge',
			context: {
				buyPathId: session.identifier,
				purchaseId: purchase.id,
				productId: purchase.productId,
				userId: purchase.userId ?? null,
				paymentAt: payment ? payment.created * 1000 : null,
				chargeId: charge?.identifier ?? null,
			},
		}
	} catch (error) {
		return { reason: 'threw', context: null, error }
	}
}

/** Preserve the existing page/API contract while telemetry uses typed outcomes. */
export async function purchaseBuyPathContext(
	purchaseId: string,
): Promise<BuyPathContext | null> {
	const result = await readPurchaseBuyPathContext(purchaseId)
	if (result.reason === 'threw') throw result.error
	return result.context
}
