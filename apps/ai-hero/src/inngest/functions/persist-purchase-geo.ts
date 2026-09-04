import { env } from '@/env.mjs'
import { inngest } from '@/inngest/inngest.server'
import { buildPurchaseGeoRowQuery } from '@/lib/admin-sales-globe-geo-backfill'
import {
	persistPurchaseGeoFromStripe,
	readStripeCheckoutGeo,
} from '@/lib/admin-sales-globe-stripe-geo'
import { log } from '@/server/logger'
import Stripe from 'stripe'

import { NEW_PURCHASE_CREATED_EVENT } from '@coursebuilder/core/inngest/commerce/event-new-purchase-created'

/**
 * Write Stripe billing and checkout metadata onto the purchase as soon as
 * fulfillment creates the row. Future checkouts also persist Vercel geo at
 * insert once Course Builder ships that write.
 */
export const persistPurchaseGeo = inngest.createFunction(
	{
		id: 'persist-purchase-geo',
		name: 'Persist Purchase Geo',
		idempotency: 'event.data.purchaseId',
	},
	{ event: NEW_PURCHASE_CREATED_EVENT },
	async ({ event, step }) => {
		const row = await step.run('load purchase', async () => {
			const rows = await buildPurchaseGeoRowQuery({
				purchaseId: event.data.purchaseId,
			})
			return rows[0] ?? null
		})

		if (!row) {
			return { skipped: true, reason: 'missing-purchase' }
		}

		const plan = await step.run('persist stripe geo', async () => {
			const stripe = new Stripe(env.STRIPE_SECRET_TOKEN, {
				apiVersion: '2024-06-20',
			})
			return persistPurchaseGeoFromStripe({
				row,
				readGeo: (candidate) =>
					readStripeCheckoutGeo({
						sessionIdentifier: candidate.sessionIdentifier,
						chargeIdentifier: candidate.chargeIdentifier,
						stripe,
					}),
			})
		})

		await log.info('purchase.geo.persisted', {
			purchaseId: event.data.purchaseId,
			skip: plan.skip,
			reason: plan.reason,
			city: plan.city,
			state: plan.state,
			precision: plan.location?.precision ?? null,
			source: plan.source,
		})

		return plan
	}
)
