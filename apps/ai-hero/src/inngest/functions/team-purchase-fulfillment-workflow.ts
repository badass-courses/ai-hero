import { inngest } from '@/inngest/inngest.server'
import { reconcileTeamPurchaseFulfillment } from '@/lib/team-purchase-fulfillment'
import { log } from '@/server/logger'

import { NEW_PURCHASE_CREATED_EVENT } from '@coursebuilder/core/inngest/commerce/event-new-purchase-created'

export const teamPurchaseFulfillmentWorkflow = inngest.createFunction(
	{
		id: 'team-purchase-organization-linkage',
		name: 'Team Purchase Organization Linkage',
		idempotency: 'event.data.purchaseId',
	},
	{ event: NEW_PURCHASE_CREATED_EVENT },
	async ({ event, step, runId }) => {
		return step.run(
			'reconcile team purchase organization linkage',
			async () => {
				const result = await reconcileTeamPurchaseFulfillment(
					event.data.purchaseId,
				)
				const logLevel = result.status === 'requires-review' ? 'warn' : 'info'
				await log[logLevel]('team_purchase_fulfillment.completed', {
					...result,
					runId,
					productType: event.data.productType,
					checkoutSessionId: event.data.checkoutSessionId ?? null,
					invoiceId: event.data.invoiceId ?? null,
				})
				return result
			},
		)
	},
)
