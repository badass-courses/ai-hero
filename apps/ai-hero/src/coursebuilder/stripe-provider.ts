import { env } from '@/env.mjs'

import StripeProvider, {
	StripePaymentAdapter,
} from '@coursebuilder/commerce/stripe-provider'

class GiftPaymentAdapter extends StripePaymentAdapter {
	async createCheckoutSession(...[params, options]: Parameters<StripePaymentAdapter['createCheckoutSession']>) {
		const { createGiftCheckout } = await import('@/lib/c5-pricing/gift-checkout')
		return createGiftCheckout({
			params,
			idempotencyKey: options?.idempotencyKey,
			create: (input, key) => super.createCheckoutSession(input, { ...options, idempotencyKey: key }),
			deps: {
				fact: async () => (await import('@/lib/c5-pricing/gift-server')).signedGiftFact(),
				claim: async (input) => {
					const { acquireDatabaseConnection } = await import('@/db')
					const { claimGiftSlot } = await import('@/lib/c5-pricing/gift-slots')
					const connection = await acquireDatabaseConnection()
					try { return await claimGiftSlot({ ...input, productId: String(params.metadata?.productId), connection, now: new Date() }) }
					finally { connection.release() }
				},
				bind: async (claim, sessionId) => {
					const { acquireDatabaseConnection } = await import('@/db')
					const { bindGiftSlot } = await import('@/lib/c5-pricing/gift-slots')
					const connection = await acquireDatabaseConnection()
					try { await bindGiftSlot(connection, claim, sessionId) }
					finally { connection.release() }
				},
				flag: async (sessionId, reason) => {
					const { log } = await import('@/server/logger')
					await log.error('c5.gift.review_required', { sessionId, reason }).catch(() => undefined)
				},
			},
		})
	}
}

export const stripeProvider = StripeProvider({
	errorRedirectUrl: `${env.COURSEBUILDER_URL}`,
	baseSuccessUrl: `${env.COURSEBUILDER_URL}`,
	cancelUrl: `${env.COURSEBUILDER_URL}`,
	paymentsAdapter: new GiftPaymentAdapter({
		stripeToken: env.STRIPE_SECRET_TOKEN,
		stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET,
	}),
})
