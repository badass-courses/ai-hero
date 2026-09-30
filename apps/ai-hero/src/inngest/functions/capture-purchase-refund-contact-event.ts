import { env } from '@/env.mjs'
import { inngest } from '@/inngest/inngest.server'
import { DrizzleCaptureMarketingRepository } from '@/lib/subscriber-marketing/drizzle-capture-repository'
import { db } from '@/db'
import { writePurchaseRefundContactEvents } from '@/lib/subscriber-marketing/purchase-refund-contact-events'
import Stripe from 'stripe'

import { REFUND_PROCESSED_EVENT } from '@coursebuilder/core/events/commerce'

export const capturePurchaseRefundContactEvent = inngest.createFunction(
	{
		id: 'capture-purchase-refund-contact-event',
		name: 'Capture Purchase Refund Contact Event',
		retries: 3,
	},
	{ event: REFUND_PROCESSED_EVENT },
	async ({ event, step, db: adapter }) => {
		const chargeId = event.data.stripeChargeId || event.data.merchantChargeId
		if (!chargeId) return { status: 'skipped', reason: 'charge-missing' }
		const purchaseId = await step.run('load refunded purchase', async () => {
			const purchase = await adapter.getPurchaseForStripeCharge(chargeId)
			if (!purchase) throw new Error('Refund purchase not available')
			return purchase.id
		})
		const refunds = await step.run('read succeeded refund facts', async () => {
			const stripe = new Stripe(env.STRIPE_SECRET_TOKEN, {
				apiVersion: '2024-06-20',
				timeout: 5000,
				maxNetworkRetries: 1,
			})
			const rows: Array<
				Pick<Stripe.Refund, 'id' | 'amount' | 'currency' | 'status' | 'created'>
			> = []
			for await (const refund of stripe.refunds.list({
				charge: chargeId,
				limit: 100,
			})) {
				rows.push({
					id: refund.id,
					amount: refund.amount,
					currency: refund.currency,
					status: refund.status,
					created: refund.created,
				})
			}
			return rows
		})
		return step.run('write refund contact events', () =>
			writePurchaseRefundContactEvents({
				repository: new DrizzleCaptureMarketingRepository(db),
				purchaseId,
				refunds,
			}),
		)
	},
)
