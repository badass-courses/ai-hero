import { db } from '@/db/client'
import { preserveQueryResultShape } from '@/db/mysql-query-client'
import * as schema from '@/db/schema'
import { drizzle } from 'drizzle-orm/mysql2'
import mysql from 'mysql2/promise'
import { createCouponBatchService } from './service'

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

export const couponBatchService = createCouponBatchService({ db, ...auth })

let worker: ReturnType<typeof createCouponBatchService> | undefined
export function couponBatchWorker() {
	if (worker) return worker
	const uri = process.env.DATABASE_URL
	if (!uri) throw new Error('coupon_batch_worker_unavailable')
	// One connection per worker process, separate from the normal commerce
	// pool. Inngest and the DB control row serialize issuer chunks globally.
	const pool = preserveQueryResultShape(
		mysql.createPool({ uri, connectionLimit: 1, maxIdle: 1, timezone: 'Z' }),
	)
	const getConnection = pool.getConnection.bind(pool)
	pool.getConnection = async () =>
		preserveQueryResultShape(await getConnection())
	const workerDb = drizzle(pool, {
		schema,
		mode: 'planetscale',
	}) as unknown as typeof db
	worker = createCouponBatchService({ db: workerDb, ...auth })
	return worker
}
