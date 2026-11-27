import { preserveQueryResultShape } from '@/db/mysql-query-client'
import type { PoolConnection as CallbackPoolConnection } from 'mysql2'
import mysql, { type Pool, type RowDataPacket } from 'mysql2/promise'

/** Synthetic MySQL only. A holder, two contenders, and a lock observer. */
export function createCouponFixturePool(uri: string) {
	const pool = preserveQueryResultShape(
		mysql.createPool({ uri, timezone: 'Z', connectionLimit: 4 }),
	)
	pool.on('connection', (connection) => {
		const raw = connection as unknown as CallbackPoolConnection
		raw.query("SET SESSION time_zone = '+00:00'", (error) => {
			if (error) raw.destroy()
		})
	})
	const getConnection = pool.getConnection.bind(pool)
	pool.getConnection = async () =>
		preserveQueryResultShape(await getConnection())
	return pool
}

export async function concurrentlyBehindRowLock<T>(
	pool: Pool,
	lockSql: string,
	rowId: string,
	table: string,
	run: () => Promise<T>,
) {
	const gate = await pool.getConnection()
	let outcome: PromiseSettledResult<T> | undefined
	let races: Promise<void> | undefined
	try {
		await gate.beginTransaction()
		const [row] = await gate.query<RowDataPacket[]>(lockSql, [rowId])
		if (row.length !== 1) throw new Error('fixture lock row missing')
		races = run().then(
			(value) => {
				outcome = { status: 'fulfilled', value }
			},
			(reason: unknown) => {
				outcome = { status: 'rejected', reason }
			},
		)
		const deadline = performance.now() + 2500
		let waiting = 0
		while (performance.now() < deadline) {
			const [rows] = await pool.query<RowDataPacket[]>(
				`
				WITH RECURSIVE wait_chain AS (
					SELECT THREAD_ID FROM performance_schema.threads WHERE PROCESSLIST_ID = ?
					UNION DISTINCT
					SELECT w.REQUESTING_THREAD_ID FROM performance_schema.data_lock_waits w
					JOIN wait_chain b ON b.THREAD_ID = w.BLOCKING_THREAD_ID
				)
				SELECT COUNT(DISTINCT r.PROCESSLIST_ID) AS waiting
				FROM wait_chain b
				JOIN performance_schema.threads r ON r.THREAD_ID = b.THREAD_ID
				WHERE LOWER(r.PROCESSLIST_INFO) LIKE ?
				AND LOWER(r.PROCESSLIST_INFO) LIKE '%for update%'`,
				[gate.threadId, `%${table.toLowerCase()}%`],
			)
			waiting = Number(rows[0]?.waiting)
			if (waiting >= 2 || outcome) break
			await new Promise((resolve) => setTimeout(resolve, 25))
		}
		if (waiting < 2)
			throw new Error(
				`expected two independent ${table} FOR UPDATE waiters; got ${waiting}`,
			)
	} finally {
		await gate.rollback()
		gate.release()
		await races
	}
	if (!outcome || outcome.status === 'rejected')
		throw outcome?.reason ?? new Error('fixture race did not finish')
	return outcome.value
}
