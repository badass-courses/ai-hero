import { createHash } from 'node:crypto'
import type { PoolConnection, RowDataPacket } from 'mysql2/promise'

/** The same lock is used by grant, revoke and payment reconciliation. It is
 * connection-scoped, nonblocking, and creates no schema or persistent ledger. */
export function createEarlyAccessLock(acquire: () => Promise<PoolConnection>) {
	return async function lock<T>(
		id: string,
		work: () => Promise<T>,
	): Promise<T> {
		const connection = await acquire()
		const key = `early-access:${createHash('sha256').update(id).digest('hex').slice(0, 40)}`
		let locked = false
		try {
			const [[row]] = await connection.query<
				(RowDataPacket & { acquired: number })[]
			>('SELECT GET_LOCK(?, 0) AS acquired', [key])
			if (row?.acquired !== 1)
				throw new Error(
					'Another early-access operation holds this invoice; retry after its readback',
				)
			locked = true
			return await work()
		} finally {
			try {
				if (locked) await connection.query('SELECT RELEASE_LOCK(?)', [key])
			} finally {
				connection.release()
			}
		}
	}
}
