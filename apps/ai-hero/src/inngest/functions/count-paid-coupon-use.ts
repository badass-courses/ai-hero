import { db } from '@/db/client'
import { inngest } from '@/inngest/inngest.server'
import { recordPaidCouponUse } from '@/lib/paid-coupon-usage'
import { log } from '@/server/logger'

import { NEW_PURCHASE_CREATED_EVENT } from '@coursebuilder/core/events/commerce'

export const countPaidCouponUse = inngest.createFunction(
	{
		id: 'count-paid-coupon-use',
		idempotency: 'event.data.purchaseId',
		onFailure: async ({ event }) => {
			await log.error('coupon_usage.accounting_failed', {
				purchaseId: event.data.event.data.purchaseId,
			})
		},
	},
	{ event: NEW_PURCHASE_CREATED_EVENT },
	async ({ event, step }) => {
		const { purchaseId } = event.data
		const attempt = (id: string) =>
			step.run(id, () => recordPaidCouponUse(db, purchaseId))
		let outcome = await attempt('count paid coupon use')
		for (const delay of ['1m', '15m', '1h'] as const) {
			if (outcome !== 'pending') return outcome
			await step.sleep(`wait for paid purchase ${delay}`, delay)
			outcome = await attempt(`count paid coupon use after ${delay}`)
		}
		if (outcome === 'pending') {
			await log.error('coupon_usage.accounting_failed', {
				purchaseId,
				reason: 'purchase-not-ready',
			})
		}
		return outcome
	},
)
