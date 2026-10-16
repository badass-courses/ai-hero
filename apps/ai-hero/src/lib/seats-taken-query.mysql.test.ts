import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MySqlDialect } from 'drizzle-orm/mysql-core'
import mysql, { type Pool } from 'mysql2/promise'

import { seatsTaken, type SeatRow } from './pricing-decisions'
import { seatsTakenSql } from './seats-taken-query'

const mysqlUrl = process.env.AIH_MYSQL_TEST_URL
const integration = describe.skipIf(!mysqlUrl)
const dialect = new MySqlDialect()

describe('seatsTakenSql (compiled)', () => {
	it('binds the product id, never inlines it, and filters to holding statuses', () => {
		const { sql: text, params } = dialect.sqlToQuery(seatsTakenSql('prod-1'))
		expect(text).not.toContain('prod-1')
		expect(params.filter((p) => p === 'prod-1')).toHaveLength(3)
		expect(params).toEqual(expect.arrayContaining(['Valid', 'Restricted']))
		expect(text).toContain('`AI_Purchase`')
		expect(text).toContain('`AI_Coupon`')
	})
})

type Case = { name: string; rows: (SeatRow & { id: string })[] }

const cases: Case[] = [
	{ name: 'empty', rows: [] },
	{
		name: 'singles by status',
		rows: ['Valid', 'Restricted', 'Refunded', 'Banned'].map((status, i) => ({
			id: `s${i}`,
			status,
		})),
	},
	{
		name: 'bulk plus redemptions',
		rows: [
			{ id: 'b', status: 'Valid', bulkCouponId: 'c1', bulkCouponMaxUses: 5 },
			{ id: 'r1', status: 'Valid', redeemedBulkCouponId: 'c1' },
			{ id: 'r2', status: 'Restricted', redeemedBulkCouponId: 'c1' },
		],
	},
	{
		name: 'add-seat purchases share one coupon',
		rows: [
			{ id: 'b1', status: 'Valid', bulkCouponId: 'c1', bulkCouponMaxUses: 8 },
			{ id: 'b2', status: 'Valid', bulkCouponId: 'c1', bulkCouponMaxUses: 8 },
		],
	},
	{
		name: 'refunded bulk keeps redeemed seats',
		rows: [
			{ id: 'b', status: 'Refunded', bulkCouponId: 'c1', bulkCouponMaxUses: 5 },
			{ id: 'r1', status: 'Valid', redeemedBulkCouponId: 'c1' },
			{ id: 'r2', status: 'Refunded', redeemedBulkCouponId: 'c1' },
		],
	},
	{
		name: 'unknown coupon quantity counts one',
		rows: [{ id: 'b', status: 'Valid', bulkCouponId: 'missing' }],
	},
]

integration('seatsTakenSql parity with seatsTaken (MySQL)', () => {
	let pool: Pool
	let db: { execute: (q: ReturnType<typeof seatsTakenSql>) => Promise<unknown> }

	beforeAll(async () => {
		pool = mysql.createPool({
			uri: mysqlUrl!,
			connectionLimit: 1,
			timezone: 'Z',
			multipleStatements: true,
		})
		await pool.query(
			'DROP TABLE IF EXISTS `AI_Purchase`; DROP TABLE IF EXISTS `AI_Coupon`;' +
				'CREATE TABLE `AI_Coupon` (id varchar(191) primary key, maxUses int not null);' +
				'CREATE TABLE `AI_Purchase` (id varchar(191) primary key, productId varchar(191), status varchar(191), bulkCouponId varchar(191), redeemedBulkCouponId varchar(191));',
		)
		db = {
			execute: async (query) => {
				const compiled = dialect.sqlToQuery(query)
				const [rows] = await pool.query(compiled.sql, compiled.params)
				return rows
			},
		}
	})
	afterAll(async () => {
		await pool?.query(
			'DROP TABLE IF EXISTS `AI_Purchase`; DROP TABLE IF EXISTS `AI_Coupon`',
		)
		await pool?.end()
	})

	for (const { name, rows } of cases) {
		it(name, async () => {
			await pool.query('DELETE FROM `AI_Purchase`; DELETE FROM `AI_Coupon`')
			const coupons = new Map<string, number>()
			for (const r of rows)
				if (r.bulkCouponId && r.bulkCouponMaxUses != null)
					coupons.set(r.bulkCouponId, r.bulkCouponMaxUses)
			for (const [id, maxUses] of coupons)
				await pool.query('INSERT INTO `AI_Coupon` VALUES (?, ?)', [id, maxUses])
			for (const r of rows)
				await pool.query('INSERT INTO `AI_Purchase` VALUES (?, ?, ?, ?, ?)', [
					r.id,
					'prod-1',
					r.status,
					r.bulkCouponId ?? null,
					r.redeemedBulkCouponId ?? null,
				])
			const result = (await db.execute(seatsTakenSql('prod-1'))) as {
				seats: unknown
			}[]
			expect(Number(result[0]!.seats)).toBe(seatsTaken(rows))
		})
	}
})
