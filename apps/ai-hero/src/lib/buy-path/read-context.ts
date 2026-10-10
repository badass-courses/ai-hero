import { courseBuilderAdapter, db } from '@/db'
import { merchantCharge, merchantSession } from '@/db/schema'
import { stripeProvider } from '@/coursebuilder/stripe-provider'
import { StripePaymentAdapter } from '@coursebuilder/commerce/stripe-provider'
import { eq } from 'drizzle-orm'
import type { BuyPathContext } from './schema'

export async function purchaseBuyPathContext(
	purchaseId: string,
): Promise<BuyPathContext | null> {
	const purchase = await courseBuilderAdapter.getPurchase(purchaseId)
	if (!purchase?.merchantSessionId) return null
	const session = await db.query.merchantSession.findFirst({
		where: eq(merchantSession.id, purchase.merchantSessionId),
	})
	if (!session?.identifier?.startsWith('cs_')) return null
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
		buyPathId: session.identifier,
		purchaseId: purchase.id,
		productId: purchase.productId,
		userId: purchase.userId ?? null,
		paymentAt: payment ? payment.created * 1000 : null,
		chargeId: charge?.identifier ?? null,
	}
}
