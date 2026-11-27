import { after } from 'next/server'
import { couponBatchHandlers } from '@/lib/coupon-batches/http'
import { logCouponBatchFailure } from '@/lib/coupon-batches/failures'
import {
	COUPON_BATCH_WAKE,
	couponBatchRuntime,
} from '@/lib/coupon-batches/runtime'

export const handlers = couponBatchHandlers(couponBatchRuntime, () => {
	after(async () => {
		try {
			const { inngest } = await import('@/inngest/inngest.server')
			await inngest.send({ name: COUPON_BATCH_WAKE, data: {} })
		} catch (error) {
			await logCouponBatchFailure('submit', 'wake', error)
			/* The cron sweep owns durable recovery. */
		}
	})
})
