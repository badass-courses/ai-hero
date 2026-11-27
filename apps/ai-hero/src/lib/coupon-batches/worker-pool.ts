import { preserveQueryResultShape } from '@/db/mysql-query-client'
import type { PoolConnection as CallbackPoolConnection } from 'mysql2'
import mysql from 'mysql2/promise'

export function createCouponBatchWorkerPool(uri: string, idleSeconds = 15) {
	if (!Number.isInteger(idleSeconds) || idleSeconds < 1 || idleSeconds > 60)
		throw new Error('invalid_coupon_worker_idle_timeout')
	const pool = preserveQueryResultShape(
		mysql.createPool({ uri, connectionLimit: 1, maxIdle: 1, timezone: 'Z' }),
	)
	pool.on('connection', (connection) => {
		// mysql2 queues this before handing the new connection to a caller.
		// UTC keeps TIMESTAMP inputs aligned with mysql2's UTC Date serializer.
		// The idle cap bounds an abandoned transaction's control-row lock.
		// PromisePool forwards the underlying callback pool's connection event.
		const raw = connection as unknown as CallbackPoolConnection
		raw.query(
			`SET SESSION time_zone = '+00:00', SESSION wait_timeout = ${idleSeconds}, SESSION innodb_lock_wait_timeout = 5`,
			(error) => {
				if (error) raw.destroy()
			},
		)
	})
	const getConnection = pool.getConnection.bind(pool)
	pool.getConnection = async () =>
		preserveQueryResultShape(await getConnection())
	return pool
}
