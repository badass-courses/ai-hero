import mysql from 'mysql2/promise'
import { expect, it, vi } from 'vitest'
import { createCouponBatchWorkerPool } from './worker-pool'

it('keeps encoded credentials, port and TLS settings from a deployment-shaped MySQL URL', async () => {
	// Construct only: no DNS lookup, connect, or real credentials.
	const ssl = encodeURIComponent(JSON.stringify({ rejectUnauthorized: true }))
	const pool = createCouponBatchWorkerPool(
		`mysql://fixture%40user:p%40ss%3Aword@mysql.example.test:3307/fixture?ssl=${ssl}`,
	)
	try {
		const { config } = (pool as unknown as { pool: { config: unknown } }).pool
		expect(config).toMatchObject({
			connectionLimit: 1,
			maxIdle: 0,
			idleTimeout: 7500,
			connectionConfig: {
				host: 'mysql.example.test',
				port: 3307,
				database: 'fixture',
				user: 'fixture@user',
				password: 'p@ss:word',
				timezone: 'Z',
				ssl: { rejectUnauthorized: true },
			},
		})
	} finally {
		await pool.end()
	}
})

it('fails closed between SET retries and recovers on a newly initialized socket', async () => {
	const clock = vi.spyOn(Date, 'now').mockReturnValue(10_000)
	const reject = vi.fn(async () => {
		throw new Error('unsupported SET')
	})
	const destroy = vi.fn()
	const query = vi
		.fn()
		.mockResolvedValueOnce([])
		.mockResolvedValueOnce([[{ ok: 1 }], []])
	const release = vi.fn()
	const acquire = vi
		.fn(async () => ({ connection: {}, query, release }))
		.mockResolvedValueOnce({ connection: {}, query: reject, destroy } as never)
		.mockResolvedValueOnce({ connection: {}, query: reject, destroy } as never)
	const create = vi.spyOn(mysql, 'createPool').mockReturnValue({
		getConnection: acquire,
	} as never)
	try {
		const pool = createCouponBatchWorkerPool('mysql://root@127.0.0.1/fixture')
		await expect(pool.query('SELECT 1')).rejects.toThrow(
			'coupon_batch_worker_session_unavailable',
		)
		await expect(pool.getConnection()).rejects.toThrow(
			'coupon_batch_worker_session_unavailable',
		)
		await expect(pool.execute('SELECT 1')).rejects.toThrow(
			'coupon_batch_worker_session_unavailable',
		)
		expect(acquire).toHaveBeenCalledOnce()
		expect(reject).toHaveBeenCalledOnce()
		expect(destroy).toHaveBeenCalledOnce()
		clock.mockReturnValue(11_000)
		await expect(pool.getConnection()).rejects.toThrow(
			'coupon_batch_worker_session_unavailable',
		)
		clock.mockReturnValue(12_999)
		await expect(pool.getConnection()).rejects.toThrow(
			'coupon_batch_worker_session_unavailable',
		)
		expect(acquire).toHaveBeenCalledTimes(2)
		clock.mockReturnValue(13_000)
		await expect(pool.query('SELECT 1')).resolves.toBeDefined()
		expect(query.mock.calls[0]?.[0]).toMatch(/^SET SESSION/)
		expect(query.mock.calls[1]?.[0]).toBe('SELECT 1')
		expect(destroy).toHaveBeenCalledTimes(2)
		expect(release).toHaveBeenCalledOnce()
	} finally {
		clock.mockRestore()
		create.mockRestore()
	}
})
