import { stripeProvider } from '@/coursebuilder/stripe-provider'
import { db } from '@/db'
import { c5DecisionCutover } from '@/lib/c5-pricing/config'
import type { FrontDeskHooks } from '@ai-hero/front-desk-support'
import type { StripePaymentAdapter } from '@coursebuilder/commerce/stripe-provider'
import { Effect } from 'effect'
import { integration } from '../support/integration'
import { buyerPricingFacts } from './pricing-facts'
import { pricingFactsSourceLayer } from './pricing-facts-source'

const stripe = (stripeProvider.options.paymentsAdapter as StripePaymentAdapter)
	.stripe

/** App-owned reads. No support mutation is reachable from this facade. */
export const hooks: FrontDeskHooks = {
	async customerByEmail(email) {
		const user = await integration.lookupUser(email)
		return user
			? {
					id: user.id,
					email: user.email,
					name: user.name ?? null,
					emailAliases: [],
				}
			: null
	},
	async purchasesForUser(userId) {
		// The legacy SDK's getPurchases labels merchantChargeId as stripeChargeId
		// and drops bulk seats. Read the existing relations instead of copying that bug.
		const rows = await db.query.purchases.findMany({
			where: (purchase, { eq, and, inArray }) =>
				and(
					eq(purchase.userId, userId),
					inArray(purchase.status, ['Valid', 'Refunded', 'Restricted']),
				),
			with: { product: true, bulkCoupon: true, merchantCharge: true },
			orderBy: (purchase, { asc }) => [asc(purchase.createdAt)],
		})
		return rows.map((purchase) => ({
			id: purchase.id,
			productId: purchase.productId,
			productName: purchase.product?.name ?? 'Unknown Product',
			amount: Math.round(Number(purchase.totalAmount) * 100),
			// Course Builder stores purchase totals in USD (same as support integration).
			currency: 'usd',
			status: purchase.status.toLowerCase(),
			createdAt: purchase.createdAt.toISOString(),
			seats:
				purchase.bulkCoupon && purchase.bulkCoupon.maxUses > 0
					? purchase.bulkCoupon.maxUses
					: 1,
			merchantChargeId: purchase.merchantChargeId ?? null,
			stripeChargeId: purchase.merchantCharge?.identifier.startsWith('ch_')
				? purchase.merchantCharge.identifier
				: null,
		}))
	},
	async chargeState(stripeChargeId) {
		let charge
		try {
			charge = await stripe.charges.retrieve(stripeChargeId)
		} catch (error) {
			if (
				typeof error === 'object' &&
				error !== null &&
				'code' in error &&
				error.code === 'resource_missing'
			)
				return null
			throw error
		}
		let refundCount = 0
		let startingAfter: string | undefined
		while (true) {
			const page = await stripe.refunds.list({
				charge: stripeChargeId,
				limit: 100,
				...(startingAfter ? { starting_after: startingAfter } : {}),
			})
			refundCount += page.data.length
			if (!page.has_more) break
			const last = page.data.at(-1)?.id
			if (!last || last === startingAfter)
				throw new Error('INVALID_REFUND_PAGE')
			startingAfter = last
		}
		const disputes = charge.disputed
			? await stripe.disputes.list({ charge: stripeChargeId, limit: 1 })
			: null
		// Stripe 16's type definitions predate these optional response fields.
		const presentment = (
			charge as typeof charge & {
				presentment_details?: {
					presentment_amount: number
					presentment_currency: string
				}
			}
		).presentment_details
		return {
			stripeChargeId: charge.id,
			amount: charge.amount,
			currency: charge.currency,
			amountRefunded: charge.amount_refunded,
			refundCount,
			disputed: charge.disputed,
			disputeStatus: disputes?.data[0]?.status ?? null,
			presentmentAmount: presentment?.presentment_amount ?? null,
			presentmentCurrency: presentment?.presentment_currency ?? null,
		}
	},
	// Evidence only. front-desk prices it on its side.
	pricingFacts(request) {
		return Effect.runPromise(
			buyerPricingFacts(request).pipe(
				Effect.provide(
					pricingFactsSourceLayer({
						chargeState: (id) => hooks.chargeState(id),
						stripe,
						decisionCutover: c5DecisionCutover(),
					}),
				),
			),
		)
	},
}
