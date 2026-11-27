import { after } from 'next/server'
import { couponBatchHandlers } from '@/lib/coupon-batches/http'
import {
	COUPON_BATCH_WAKE,
	couponBatchRuntime,
} from '@/lib/coupon-batches/runtime'

export const handlers = couponBatchHandlers(couponBatchRuntime, () => {
	after(async () => {
		try {
			const { inngest } = await import('@/inngest/inngest.server')
			await inngest.send({ name: COUPON_BATCH_WAKE, data: {} })
		} catch {
			/* The cron sweep owns durable recovery. */
		}
	})
})
