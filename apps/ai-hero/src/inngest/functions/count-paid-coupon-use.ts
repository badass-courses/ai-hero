import { db } from '@/db/client'
import { inngest } from '@/inngest/inngest.server'
import { recordPaidCouponUse } from '@/lib/paid-coupon-usage'
import { log } from '@/server/logger'

import { NEW_PURCHASE_CREATED_EVENT } from '@coursebuilder/core/events/commerce'

export const countPaidCouponUse = inngest.createFunction(
	{
		id: 'count-paid-coupon-use',
		idempotency: 'event.data.purchaseId',
		onFailure: async () => {
			await log.error('coupon_usage.accounting_failed')
		},
	},
	{ event: NEW_PURCHASE_CREATED_EVENT },
	async ({ event, step }) =>
		step.run('count paid coupon use', () =>
			recordPaidCouponUse(db, event.data.purchaseId),
		),
)
