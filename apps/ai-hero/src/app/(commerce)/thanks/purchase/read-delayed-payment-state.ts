import 'server-only'

import { stripeProvider } from '@/coursebuilder/stripe-provider'
import { log } from '@/server/logger'

import type { StripePaymentAdapter } from '@coursebuilder/commerce/stripe-provider'

import { delayedPaymentState, type DelayedPaymentState } from './delayed-payment-state'

/** The thanks page is public: junk ids must not spend the Stripe rate limit. */
const CHECKOUT_SESSION_ID = /^cs_(live|test)_[A-Za-z0-9]{20,}$/

/**
 * One bounded Stripe read for a checkout that has no purchase yet. Any
 * failure falls back to the normal wait screen, which is what the buyer saw
 * before this check existed.
 */
export async function readDelayedPaymentState(
	checkoutSessionId: string,
): Promise<DelayedPaymentState> {
	if (!CHECKOUT_SESSION_ID.test(checkoutSessionId)) {
		return { kind: 'not_delayed' }
	}
	try {
		const stripe = (
			stripeProvider.options.paymentsAdapter as StripePaymentAdapter
		).stripe
		const session = await stripe.checkout.sessions.retrieve(
			checkoutSessionId,
			{ expand: ['payment_intent'] },
			{ timeout: 3000, maxNetworkRetries: 0 },
		)
		return delayedPaymentState(session)
	} catch {
		await log.warn('checkout.thanks.payment_state_unavailable', {
			checkoutSessionId,
		})
		return { kind: 'not_delayed' }
	}
}
