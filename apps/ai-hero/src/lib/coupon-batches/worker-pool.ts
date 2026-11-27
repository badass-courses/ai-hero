import { preserveQueryResultShape } from '@/db/mysql-query-client'
import type { PoolConnection as CallbackPoolConnection } from 'mysql2'
import mysql, { type PoolConnection } from 'mysql2/promise'

export function createCouponBatchWorkerPool(uri: string, idleSeconds = 15) {
	if (!Number.isInteger(idleSeconds) || idleSeconds < 1 || idleSeconds > 60)
		throw new Error('invalid_coupon_worker_idle_timeout')
	// mysql2 starts its idle reaper only when maxIdle < connectionLimit.
	const pool = mysql.createPool({
		uri,
		connectionLimit: 1,
		maxIdle: 0,
		idleTimeout: idleSeconds * 500,
		timezone: 'Z',
	})
	const initialized = new WeakSet<CallbackPoolConnection>()
	let retryAt = 0
	let failures = 0
	const coolingDown = () => Date.now() < retryAt
	const acquire = pool.getConnection.bind(pool)
	pool.getConnection = async () => {
		if (coolingDown())
			throw new Error('coupon_batch_worker_session_unavailable')
		const connection = await acquire()
		// The promise wrapper is recreated at each checkout of the same socket.
		const socket = (
			connection as unknown as { connection: CallbackPoolConnection }
		).connection
		if (coolingDown()) {
			connection.release()
			throw new Error('coupon_batch_worker_session_unavailable')
		}
		if (!initialized.has(socket)) {
			try {
				await connection.query(
					`SET SESSION time_zone = '+00:00', SESSION wait_timeout = ${idleSeconds}, SESSION innodb_lock_wait_timeout = 5`,
				)
				initialized.add(socket)
				failures = 0
				retryAt = 0
			} catch {
				retryAt =
					Date.now() + Math.min(60_000, 1000 * 2 ** Math.min(failures++, 6))
				connection.destroy()
				throw new Error('coupon_batch_worker_session_unavailable')
			}
		}
		return preserveQueryResultShape(connection)
	}
	// mysql2 Pool.query/execute otherwise bypass the checked promise checkout.
	for (const method of ['query', 'execute'] as const) {
		pool[method] = (async (...args: unknown[]) => {
			const connection = await pool.getConnection()
			try {
				return await Reflect.apply(connection[method], connection, args)
			} finally {
				connection.release()
			}
		}) as PoolConnection[typeof method]
	}
	return preserveQueryResultShape(pool)
}
