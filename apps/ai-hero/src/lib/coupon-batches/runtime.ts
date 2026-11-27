import type { db } from '@/db/client'
import * as schema from '@/db/schema'
import { drizzle } from 'drizzle-orm/mysql2'
import { createCouponBatchService } from './service'
import { createCouponBatchWorkerPool } from './worker-pool'

export const COUPON_BATCH_WAKE = 'commerce/coupon-batches.wake' as const
export const couponBatchEnabled = () =>
	process.env.AIH_COUPON_BATCH_ENABLED === 'true'

const auth = {
	enabled: couponBatchEnabled,
	patSecret: () => process.env.PERSONAL_ACCESS_TOKEN_SECRET,
	batchSecret: () => {
		const value = process.env.AIH_COUPON_BATCH_SECRET
		return value && Buffer.byteLength(value) >= 32 ? value : undefined
	},
}

let database: typeof db | undefined
export function couponBatchDatabase() {
	if (database) return database
	const uri = process.env.DATABASE_URL
	if (!uri) throw new Error('coupon_batch_worker_unavailable')
	// One UTC connection per issuer process, separate from checkout. The DB
	// control row serializes the worker globally, including at rollover.
	const pool = createCouponBatchWorkerPool(uri)
	database = drizzle(pool, {
		schema,
		mode: 'planetscale',
	}) as unknown as typeof db
	return database
}

let service: ReturnType<typeof createCouponBatchService> | undefined
export function couponBatchRuntime() {
	return (service ??= createCouponBatchService({
		db: couponBatchDatabase(),
		...auth,
	}))
}

export const couponBatchWorker = couponBatchRuntime
