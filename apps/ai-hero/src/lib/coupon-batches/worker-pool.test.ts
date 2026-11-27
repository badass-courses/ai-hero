import { expect, it } from 'vitest'
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
