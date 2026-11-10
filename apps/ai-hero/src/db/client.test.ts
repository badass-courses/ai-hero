import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	createPool: vi.fn(),
	stripeImport: vi.fn(),
	adapter: vi.fn((..._args: unknown[]) => ({})),
}))
vi.mock('mysql2/promise', () => ({ default: { createPool: mocks.createPool } }))
vi.mock('@/env.mjs', () => { throw new Error('app env evaluated') })
vi.mock('@/coursebuilder/stripe-provider', () => {
	mocks.stripeImport()
	return { stripeProvider: {} }
})
vi.mock('@coursebuilder/adapter-drizzle', () => ({ DrizzleAdapter: mocks.adapter }))
vi.mock('@/lib/legend-gift-coupon-guard', () => ({ guardLegendGiftCouponPaths: (adapter: unknown) => adapter }))
vi.mock('@/server/session-access-busts', () => ({ withSessionAccessBusts: (adapter: unknown) => adapter }))
vi.mock('@/server/session-access-runtime', () => ({ bustSessionAccessForUser: vi.fn() }))

beforeEach(() => {
	vi.resetModules()
	vi.clearAllMocks()
	vi.stubEnv('DATABASE_URL', 'mysql://test:test@localhost:1/mock_only')
	vi.stubEnv('DATABASE_POOL_SIZE', '')
	delete process.env.DATABASE_POOL_SIZE
	mocks.createPool.mockImplementation(() => ({
		query: vi.fn(async () => [{ affectedRows: 3, insertId: 7 }, []]),
		getConnection: vi.fn(async () => ({
			query: vi.fn(async () => [{ affectedRows: 1, insertId: 8 }, []]),
		})),
		end: vi.fn(async () => {}),
	}))
})
afterEach(() => {
	vi.unstubAllEnvs()
})

describe('shared database client', () => {
	it('needs only DATABASE_URL and preserves pool options without app composition', async () => {
		const client = await import('./client')
		expect(client.db).toBeDefined()
		expect(mocks.stripeImport).not.toHaveBeenCalled()
		expect(mocks.adapter).not.toHaveBeenCalled()
		expect(mocks.createPool).toHaveBeenCalledOnce()
		expect(mocks.createPool).toHaveBeenCalledWith({
			uri: process.env.DATABASE_URL,
			connectionLimit: 2,
			maxIdle: 2,
			timezone: 'Z',
			enableKeepAlive: true,
		})
	})

	it('keeps the app exports and uses the identical client and owned pool', async () => {
		const app = await import('./index')
		const client = await import('./client')
		expect(Object.keys(app).sort()).toEqual([
			'acquireDatabaseConnection', 'closeDatabasePool', 'courseBuilderAdapter',
			'createDatabaseHandle', 'db',
		])
		for (const key of ['db', 'acquireDatabaseConnection', 'createDatabaseHandle', 'closeDatabasePool'] as const) {
			expect(app[key]).toBe(client[key])
		}
		expect(mocks.createPool).toHaveBeenCalledOnce()
		expect(mocks.adapter.mock.calls[0]?.[0]).toBe(client.db)
		await Promise.all([app.closeDatabasePool(), client.closeDatabasePool()])
		expect(mocks.createPool.mock.results[0]?.value.end).toHaveBeenCalledOnce()
	})

	it('preserves query result fields on both the pool and acquired connections', async () => {
		const client = await import('./client')
		const pool = mocks.createPool.mock.results[0]?.value
		expect(await pool.query('mock')).toMatchObject({ rowsAffected: 3, insertId: '7', rows: [] })
		const connection = await client.acquireDatabaseConnection()
		expect(await connection.query('mock')).toMatchObject({ rowsAffected: 1, insertId: '8', rows: [] })
		// Handles for alternate table sets still share the original pool.
		expect(client.createDatabaseHandle({})).toBeDefined()
		expect(mocks.createPool).toHaveBeenCalledOnce()
	})

	it('honors an explicit pool size for both limits', async () => {
		vi.stubEnv('DATABASE_POOL_SIZE', '5')
		await import('./client')
		expect(mocks.createPool).toHaveBeenCalledWith(expect.objectContaining({ connectionLimit: 5, maxIdle: 5 }))
	})

	it.each([undefined, '', '   '])('rejects missing DATABASE_URL (%s) before creating a pool', async (value) => {
		vi.stubEnv('DATABASE_URL', value ?? '')
		if (value === undefined) delete process.env.DATABASE_URL
		await expect(import('./client')).rejects.toThrow('DATABASE_URL')
		expect(mocks.createPool).not.toHaveBeenCalled()
	})

	it.each(['', '0', '-1', '1.5', 'abc', 'NaN', 'Infinity', '2e2', ' 2 ', '9007199254740992'])('rejects malformed DATABASE_POOL_SIZE (%s)', async (value) => {
		vi.stubEnv('DATABASE_POOL_SIZE', value)
		await expect(import('./client')).rejects.toThrow('DATABASE_POOL_SIZE')
		expect(mocks.createPool).not.toHaveBeenCalled()
	})
})
