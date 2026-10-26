/**
 * Fulfills a delayed-payment checkout (bank transfer) when Stripe reports the
 * money arrived. Course Builder only logs `checkout.session.async_payment_succeeded`;
 * the Course Builder route sends `CHECKOUT_ASYNC_PAYMENT_SUCCEEDED_EVENT` for
 * it, keyed by the Stripe event id.
 *
 * This is the normal path for these orders, not the reconciler, so it does not
 * read `AIH_CHECKOUT_RECONCILER_AUTO_FULFILL`. The instant kill is pausing
 * `checkout-async-payment-fulfill` in the Inngest dashboard.
 */
import { db } from '@/db'
import { env } from '@/env.mjs'
import { CHECKOUT_ASYNC_PAYMENT_SUCCEEDED_EVENT } from '@/inngest/events/checkout-async-payment'
import { inngest } from '@/inngest/inngest.server'
import { AUTHORITATIVE_PRODUCT_IDS } from '@/lib/c5-pricing/decision'
import { fulfillAsyncPaidCheckout } from '@/lib/checkout-reconcile/delayed-payment'
import {
	findCheckoutHandler,
	type CheckoutFulfillDatabase,
	type DirectCheckoutFulfillmentResult,
} from '@/lib/checkout-reconcile/fulfill'
import {
	findBuyerProductPurchaseIds,
	inspectCheckoutFulfillment,
} from '@/lib/checkout-reconcile/inspect'
import {
	checkoutChargeState,
	safeCheckoutErrorLabel,
} from '@/lib/checkout-reconcile/policy'
import { log } from '@/server/logger'
import { courseBuilderCoreFunctions } from '@coursebuilder/server'

import {
	checkoutPurchaseWritesLimit,
	paymentsAdapter,
	sendOpsAlert,
} from './checkout-reconciler'

/** Skips that are not this app's order to fulfill. Anything else needs a human. */
const EXPECTED_SKIPS = new Set(['other_site', 'not_payment_mode', 'zero_total'])

export const checkoutAsyncPaymentFulfill = inngest.createFunction(
	{
		id: 'checkout-async-payment-fulfill',
		name: 'Checkout Async Payment Fulfill',
		// One run per session. Stripe redelivery is also deduped by event id,
		// and the guards in `fulfillCheckoutSessionDirectly` hold past 24 hours.
		idempotency: 'event.data.checkoutSessionId',
		retries: 4,
		concurrency: [
			{ key: 'event.data.checkoutSessionId', limit: 1 },
			{
				scope: 'env',
				key: '"checkout-purchase-writes"',
				limit: checkoutPurchaseWritesLimit(),
			},
		],
		onFailure: async ({ event, error }) => {
			const checkoutSessionId = event.data.event.data.checkoutSessionId
			const label = safeCheckoutErrorLabel(error)
			await log.error('checkout.async_payment.fulfill_failed', {
				checkoutSessionId,
				...label,
			})
			await sendOpsAlert({
				title: 'Bank transfer arrived but the checkout was not fulfilled',
				text: `\`${checkoutSessionId}\`: ${label.errorName}: ${label.errorSummary}\nFull error in the Inngest run. Run \`pnpm checkout:recover --checkout-session-id ${checkoutSessionId} --direct\` for a dry run first.`,
				color: '#d92d20',
			})
		},
	},
	{ event: CHECKOUT_ASYNC_PAYMENT_SUCCEEDED_EVENT },
	async ({ event, step, db: adapter, paymentProvider, notificationProvider }) => {
		const { checkoutSessionId } = event.data
		// Stripe reported the payment, so the charge should be readable. If it is
		// not yet, this step throws and Inngest retries the read; the fulfill
		// path's own session read is memoized and would not see a later charge.
		await step.run('wait for the paid charge', async () => {
			const session =
				await paymentsAdapter(paymentProvider).getCheckoutSession(
					checkoutSessionId,
				)
			if (session.payment_status === 'paid' && !checkoutChargeState(session).expanded) {
				throw new Error(
					`Charge not readable yet for async-paid checkout ${checkoutSessionId}`,
				)
			}
			return null
		})
		const result = await fulfillAsyncPaidCheckout(checkoutSessionId, {
			handler: findCheckoutHandler(courseBuilderCoreFunctions),
			step,
			db: adapter as unknown as CheckoutFulfillDatabase,
			paymentProvider,
			notificationProvider,
			getCheckoutSession: (id) =>
				paymentsAdapter(paymentProvider).getCheckoutSession(id),
			onPaidSession: async (session) =>
				(await import('@/lib/c5-pricing/gift-settlement')).settleGiftSession(
					session,
				),
			inspect: (input) => inspectCheckoutFulfillment(db, input),
			// C5 duplicates are fulfilled and flagged after payment, never held.
			holdsWhenBuyerHasProduct: (productId) =>
				!AUTHORITATIVE_PRODUCT_IDS.has(productId),
			findBuyerProductPurchases: (input) =>
				findBuyerProductPurchaseIds(db, input),
			appName: env.NEXT_PUBLIC_APP_NAME,
			now: () => new Date(),
			txnId: `aih-checkout-async-paid-${checkoutSessionId}`,
		})


		await step.run('record async payment outcome', () =>
			recordOutcome(checkoutSessionId, result),
		)
		return result
	},
)

async function recordOutcome(
	checkoutSessionId: string,
	result: DirectCheckoutFulfillmentResult,
) {
	const event = `checkout.async_payment.${result.status}`
	if (result.status === 'held') {
		await log.error(event, { ...result })
		await sendOpsAlert({
			title: 'Bank transfer arrived for a buyer who already has the product',
			text: `\`${checkoutSessionId}\`: the buyer already has this product (purchase ${result.purchaseIds.map((id) => `\`${id}\``).join(', ')}), not from this checkout. Nothing was created. Check for a gift or hand fix, then link or refund.`,
			color: '#f79009',
		})
		return null
	}
	if (result.status === 'skipped' && !EXPECTED_SKIPS.has(result.reason)) {
		await log.warn(event, { ...result })
		await sendOpsAlert({
			title: 'Bank transfer arrived but the checkout was skipped',
			text: `\`${checkoutSessionId}\`: ${result.reason}. Nothing was created. Check the session in Stripe.`,
			color: '#f79009',
		})
		return null
	}
	await log.info(event, { ...result })
	return null
}
