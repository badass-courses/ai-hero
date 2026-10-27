import { randomUUID } from 'node:crypto'

import * as schema from '@/db/schema'
import { AI_CODING_CRASH_COURSE_PRODUCT_ID } from '@/lib/crash-course-purchaser-tag'
import { is, SQL } from 'drizzle-orm'
import { getTableConfig, MySqlDialect } from 'drizzle-orm/mysql-core'
import { drizzle } from 'drizzle-orm/mysql2'
import mysql, { type Pool } from 'mysql2/promise'
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from 'vitest'

import { validateMySqlIntegrationServerUrl } from '../team-purchase-mysql-test-guard'

vi.mock('server-only', () => ({}))
vi.mock('@/db', () => ({ db: {} }))
vi.mock('@/env.mjs', () => ({ env: {} }))
vi.mock('@/server/redis-client', () => ({ redis: { get: vi.fn() } }))

import { findCrashCoursePurchaseStatuses } from './purchase-exit-proof.server'

const mysqlServerUrl = process.env.AIH_EVERGREEN_JOURNEY_MYSQL_TEST_SERVER_URL
const integration = describe.skipIf(!mysqlServerUrl)
const dialect = new MySqlDialect()

// Disposable DDL from the installed schema, never a production clone.
async function createFixtureSchema(pool: Pool) {
	for (const table of [schema.users, schema.purchases]) {
		const config = getTableConfig(table)
		const columns = config.columns.map((column) => {
			const fallback =
				column.default === undefined
					? ''
					: column.default === null
						? ' DEFAULT NULL'
						: is(column.default, SQL)
							? ` DEFAULT ${dialect.sqlToQuery(column.default).sql}`
							: column.getSQLType() === 'json'
								? ` DEFAULT ('${JSON.stringify(column.default)}')`
								: ` DEFAULT '${String(column.default)}'`
			return `\`${column.name}\` ${column.getSQLType()}${column.notNull ? ' NOT NULL' : ''}${fallback}${column.primary ? ' PRIMARY KEY' : ''}`
		})
		if (!config.columns.some((column) => column.primary))
			for (const key of config.primaryKeys)
				columns.push(
					`PRIMARY KEY (${key.columns.map((column) => `\`${column.name}\``).join(',')})`,
				)
		await pool.query(`DROP TABLE IF EXISTS \`${config.name}\``)
		await pool.query(
			`CREATE TABLE \`${config.name}\` (${columns.join(',')}) ENGINE=InnoDB`,
		)
	}
}

integration('crash course purchase statuses on MySQL', () => {
	let serverPool: Pool
	let pool: Pool
	let database: Parameters<typeof findCrashCoursePurchaseStatuses>[1]
	let databaseName: string
	let serial = 0

	beforeAll(async () => {
		const safe = validateMySqlIntegrationServerUrl(mysqlServerUrl!, {
			nodeEnv: process.env.NODE_ENV,
			vercelEnv: process.env.VERCEL_ENV,
		})
		serverPool = mysql.createPool({
			uri: safe.toString(),
			connectionLimit: 1,
			timezone: 'Z',
		})
		databaseName = `aih_purchase_exit_test_${randomUUID().replaceAll('-', '')}`
		// Case-insensitive collation, as the users table runs in production.
		await serverPool.query(
			`CREATE DATABASE \`${databaseName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
		)
		const url = new URL(safe)
		url.pathname = `/${databaseName}`
		pool = mysql.createPool({
			uri: url.toString(),
			connectionLimit: 4,
			timezone: 'Z',
		})
		await createFixtureSchema(pool)
		database = drizzle(pool, { schema, mode: 'default' }) as never
	})

	beforeEach(async () => {
		await pool.query('DELETE FROM `AI_User`')
		await pool.query('DELETE FROM `AI_Purchase`')
	})

	afterAll(async () => {
		await pool?.end()
		if (serverPool && databaseName)
			await serverPool.query(`DROP DATABASE IF EXISTS \`${databaseName}\``)
		await serverPool?.end()
	})

	async function buyer(
		email: string,
		purchase: {
			status?: string
			productId?: string
			bulkCouponId?: string | null
			redeemedBulkCouponId?: string | null
		} = {},
	) {
		serial += 1
		const userId = `user-${serial}`
		await pool.query('INSERT INTO `AI_User` (id, email) VALUES (?, ?)', [
			userId,
			email,
		])
		await pool.query(
			'INSERT INTO `AI_Purchase` (id, userId, productId, status, totalAmount, bulkCouponId, redeemedBulkCouponId) VALUES (?, ?, ?, ?, 0, ?, ?)',
			[
				`purchase-${serial}`,
				userId,
				purchase.productId ?? AI_CODING_CRASH_COURSE_PRODUCT_ID,
				purchase.status ?? 'Valid',
				purchase.bulkCouponId ?? null,
				purchase.redeemedBulkCouponId ?? null,
			],
		)
	}

	it('matches regardless of email case and lower-cases the key', async () => {
		await buyer('Mixed.Case@Example.test')
		const found = await findCrashCoursePurchaseStatuses(
			['mixed.case@example.test'],
			database,
		)
		expect([...found.keys()]).toEqual(['mixed.case@example.test'])
		expect(found.get('mixed.case@example.test')).toEqual(['Valid'])
	})

	it('returns every status for the product and ignores another product', async () => {
		await buyer('a@example.test', { status: 'Refunded' })
		await buyer('b@example.test', { productId: 'some-other-product' })
		await buyer('c@example.test', { status: 'Restricted' })
		const found = await findCrashCoursePurchaseStatuses(
			[
				'a@example.test',
				'b@example.test',
				'c@example.test',
				'none@example.test',
			],
			database,
		)
		expect(found.get('a@example.test')).toEqual(['Refunded'])
		expect(found.has('b@example.test')).toBe(false)
		expect(found.get('c@example.test')).toEqual(['Restricted'])
		expect(found.has('none@example.test')).toBe(false)
	})

	it('does not count a bulk purchaser, but counts a redeemed seat', async () => {
		await buyer('bulk@example.test', { bulkCouponId: 'coupon-1' })
		await buyer('seat@example.test', { redeemedBulkCouponId: 'coupon-1' })
		const found = await findCrashCoursePurchaseStatuses(
			['bulk@example.test', 'seat@example.test'],
			database,
		)
		expect(found.has('bulk@example.test')).toBe(false)
		expect(found.get('seat@example.test')).toEqual(['Valid'])
	})

	it('answers an empty list without a query', async () => {
		expect(await findCrashCoursePurchaseStatuses([], database)).toEqual(
			new Map(),
		)
	})
})
