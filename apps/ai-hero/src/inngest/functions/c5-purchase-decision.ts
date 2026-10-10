/**
 * Saves the pricing decision a paid C5 checkout charged onto its purchase,
 * then runs the post-payment duplicate check.
 *
 * The core `stripe-checkout-session-completed` handler sends
 * `new-purchase-created` after it writes the purchase. The webhook path and
 * the checkout reconciler (#386) both run that handler, so every C5 purchase
 * reaches this function, however it was fulfilled.
 *
 * It never blocks or reverses fulfillment: a duplicate is flagged on the
 * purchase, logged and sent to the ops channel for a refund decision.
 */
import { slackProvider } from '@/coursebuilder/slack-provider'
import { stripeProvider } from '@/coursebuilder/stripe-provider'
import { inngest } from '@/inngest/inngest.server'
import { C5_PRODUCT_ID } from '@/lib/c5-pricing/decision'
import { recordC5PurchaseDecision } from '@/lib/c5-pricing/purchase-decision'
import { drizzleC5DecisionStore } from '@/lib/c5-pricing/purchase-decision-store'
import { log } from '@/server/logger'

import { NEW_PURCHASE_CREATED_EVENT } from '@coursebuilder/core/events/commerce'
import type { StripePaymentAdapter } from '@coursebuilder/commerce/stripe-provider'

const stripe = () =>
	(stripeProvider.options.paymentsAdapter as StripePaymentAdapter).stripe

export const c5PurchaseDecision = inngest.createFunction(
	{
		id: 'c5-purchase-decision',
		name: 'C5 Purchase Decision and Duplicate Check',
		idempotency: 'event.data.purchaseId',
		retries: 5,
		// Until its decision is saved, the purchase holds credit use for every
		// Crash Course purchase in its holder's transfer chain. Safe, but those
		// buyers cannot check out, so someone needs to save it.
		onFailure: async ({ event, error }) => {
			const purchaseId = event.data.event.data.purchaseId
			await log.error('c5.purchase.decision_failed', {
				purchaseId,
				error: error.message,
			})
			if (!slackProvider.defaultChannelId) return
			await slackProvider.sendNotification({
				channel: slackProvider.defaultChannelId,
				text: 'C5 purchase decision was not saved',
				attachments: [
					{
						fallback: `Purchase ${purchaseId}: decision not saved`,
						color: '#d92d20',
						title: 'C5 purchase decision was not saved',
						text: `\`${purchaseId}\` paid, but its pricing decision was not saved after retries. Until it is saved, any C5 checkout whose Crash Course credit shares this buyer's transfer chain is held. Fix the cause, then rerun this run (see the C5 pricing runbook). Error: ${error.message}`,
					},
				],
			})
		},
	},
	{
		event: NEW_PURCHASE_CREATED_EVENT,
		if: 'event.data.productType == "cohort"',
	},
	async ({ event, step }) => {
		const purchaseId = event.data.purchaseId
		const checkoutSessionId =
			'checkoutSessionId' in event.data
				? ((event.data.checkoutSessionId as string | undefined) ?? null)
				: null

		const result = await step.run('save decision and check duplicates', () =>
			recordC5PurchaseDecision({
				purchaseId,
				checkoutSessionId,
				store: drizzleC5DecisionStore(),
				getCheckoutSession: async (id) => {
					const session = await stripe().checkout.sessions.retrieve(id)
					return { id: session.id, metadata: session.metadata ?? null }
				},
				now: () => new Date(),
			}),
		)
		if (result.status === 'conflict') {
			await log.error('c5.purchase.decision_conflict', {
				purchaseId,
				checkoutSessionId,
				expectedRef: result.expectedRef,
				storedRef: result.storedRef,
			})
			await step.run('alert ops: C5 decision conflict', async () => {
				if (!slackProvider.defaultChannelId) return 'no-channel'
				await slackProvider.sendNotification({
					channel: slackProvider.defaultChannelId,
					text: 'C5 purchase decision conflict. Original ledger row preserved.',
					attachments: [
						{
							fallback: `Purchase ${purchaseId}: decision conflict`,
							color: '#d92d20',
							title: 'C5 purchase decision conflict',
							text: `Purchase \`${purchaseId}\` has a different decisionRef. The original ledger row was not overwritten. Review the checkout and ledger; fulfillment was not reversed.`,
						},
					],
				})
				return 'sent'
			})
			return result
		}
		if (!('verdict' in result)) return result

		await log.info('c5.purchase.decision', {
			purchaseId,
			checkoutSessionId,
			status: result.status,
			verdict: result.verdict.kind,
		})
		if (result.verdict.kind === 'duplicate') {
			const { duplicateOf, reasons } = result.verdict
			await log.warn('c5.purchase.duplicate', {
				purchaseId,
				checkoutSessionId,
				productId: C5_PRODUCT_ID,
				duplicateOf,
				reasons,
			})
			await step.run('alert ops: duplicate C5 purchase', async () => {
				if (!slackProvider.defaultChannelId) return 'no-channel'
				await slackProvider.sendNotification({
					channel: slackProvider.defaultChannelId,
					text: 'Duplicate C5 purchase flagged for refund',
					attachments: [
						{
							fallback: `Purchase ${purchaseId} duplicates ${duplicateOf.join(', ')}`,
							color: '#f79009',
							title: 'Duplicate C5 purchase flagged for refund',
							text: `\`${purchaseId}\` (${reasons.join(', ')}) duplicates ${duplicateOf.map((id: string) => `\`${id}\``).join(', ')}. Fulfillment was not blocked; decide the refund.`,
						},
					],
				})
				return 'sent'
			})
		}
		return result
	},
)
