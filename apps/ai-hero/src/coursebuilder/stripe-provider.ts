import { env } from '@/env.mjs'

import StripeProvider, {
	StripePaymentAdapter,
} from '@coursebuilder/commerce/stripe-provider'

export const stripeProvider = StripeProvider({
	errorRedirectUrl: `${env.COURSEBUILDER_URL}`,
	baseSuccessUrl: `${env.COURSEBUILDER_URL}`,
	cancelUrl: `${env.COURSEBUILDER_URL}`,
	paymentsAdapter: new StripePaymentAdapter({
		stripeToken: env.STRIPE_SECRET_TOKEN,
		stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET,
	}),
})
