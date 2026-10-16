import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import mysql, { type Connection } from 'mysql2/promise'
import { MySqlDialect } from 'drizzle-orm/mysql-core'
import {
	formatPromoRevenue,
	promoKindOf,
	promoWindow,
	type PromoAggregateRow,
} from './promos'
import { promoRevenueSql } from './promos-query'
import { promoCases } from './promos.fixtures'
import { promoFixtureDdl } from './promos-fixture-schema'

const url = process.env.AIH_MYSQL_TEST_URL
const dialect = new MySqlDialect()
// Own disposable database only. Never touch the URL's database or existing tables.
describe.skipIf(!url)('promo SQL parity (synthetic MySQL)', () => {
	let connection: Connection
	let databaseName: string
	const options = {
		from: '2026-01-01T18:00:00.001Z',
		to: '2026-01-02T18:00:00.001Z',
		productId: 'synthetic-product',
	}
	const window = promoWindow(options)
	beforeAll(async () => {
		const target = new URL(url!)
		if (!['localhost', '127.0.0.1', '[::1]'].includes(target.hostname))
			throw new Error('MySQL fixtures must be local')
		const prefix = target.pathname.slice(1).replace(/_app$/, '') || 'aih'
		if (!/^[a-zA-Z0-9_]+$/.test(prefix))
			throw new Error('Invalid fixture database prefix')
		databaseName = `${prefix}_promos_${process.pid}_${Date.now()}`
		connection = await mysql.createConnection({ uri: url!, timezone: 'Z' })
		await connection.query(`CREATE DATABASE \`${databaseName}\``)
		await connection.query(`USE \`${databaseName}\``)
		await connection.query("SET time_zone = '-08:00'")
		for (const ddl of promoFixtureDdl) await connection.query(ddl)
	})
	afterAll(async () => {
		if (connection) {
			await connection.query(`DROP DATABASE IF EXISTS \`${databaseName}\``)
			await connection.end()
		}
	})

	it.each(promoCases)(
		'$name agrees with pure classification and paid accounting',
		async ({ purchase, facts, kind }) => {
			await connection.query('DELETE FROM AI_Purchase')
			await connection.query('DELETE FROM AI_Coupon')
			await connection.query('DELETE FROM AI_MerchantCoupon')
			const merchantId = facts.merchantCouponFound
				? (purchase.couponId ?? 'synthetic-merchant')
				: null
			if (merchantId)
				await connection.query('INSERT INTO AI_MerchantCoupon VALUES (?, ?)', [
					merchantId,
					facts.merchantCouponType ?? 'special',
				])
			if (facts.siteCouponFound && purchase.couponId)
				await connection.query('INSERT INTO AI_Coupon VALUES (?, ?, ?)', [
					purchase.couponId,
					JSON.stringify(facts.fields ?? {}),
					merchantId,
				])
			if (merchantId && !purchase.couponId)
				await connection.query('INSERT INTO AI_Coupon VALUES (?, ?, ?)', [
					'synthetic-bulk',
					'{}',
					merchantId,
				])
			await connection.query(
				'INSERT INTO AI_Purchase VALUES (?, ?, FROM_UNIXTIME(?), ?, ?, ?, ?, ?)',
				[
					'synthetic-row',
					options.productId,
					Date.parse('2026-01-02T00:00:00Z') / 1000,
					purchase.status,
					purchase.totalAmount,
					purchase.couponId ?? null,
					purchase.redeemedBulkCouponId ?? null,
					merchantId && !purchase.couponId ? 'synthetic-bulk' : null,
				],
			)
			const query = dialect.sqlToQuery(promoRevenueSql(options, window))
			const [rows] = await connection.query(query.sql, query.params)
			expect(promoKindOf(purchase, facts)).toBe(kind)
			const result = formatPromoRevenue(rows as PromoAggregateRow[], window)
			const paid =
				purchase.redeemedBulkCouponId == null &&
				Number(purchase.totalAmount) > 0 &&
				['Valid', 'Restricted', 'Refunded'].includes(purchase.status ?? '')
			const gross = paid ? Number(purchase.totalAmount) : 0
			const refunds = paid && purchase.status === 'Refunded' ? gross : 0
			expect(result.daily).toEqual([
				{
					date: '2026-01-02',
					kind,
					currency: 'USD',
					recordCount: 1,
					purchaseCount: paid ? 1 : 0,
					gross,
					refunds,
					net: gross - refunds,
				},
			])
		},
	)

	it('groups original and refunded amounts without counting seat redemptions as paid', async () => {
		await connection.query('DELETE FROM AI_Purchase')
		await connection.query('DELETE FROM AI_Coupon')
		await connection.query('INSERT INTO AI_Coupon VALUES (?, ?, NULL)', [
			'synthetic-evergreen',
			JSON.stringify({ evergreenOffer: {} }),
		])
		for (const [id, status, amount, seat] of [
			['paid', 'Valid', '25.50', null],
			['refunded', 'Refunded', '12.25', null],
			['seat', 'Valid', '25.50', 'synthetic-team'],
			['zero', 'Valid', '0', null],
		] as const) {
			await connection.query(
				'INSERT INTO AI_Purchase VALUES (?, ?, FROM_UNIXTIME(?), ?, ?, ?, ?, NULL)',
				[
					id,
					options.productId,
					Date.parse(options.from) / 1000,
					status,
					amount,
					'synthetic-evergreen',
					seat,
				],
			)
		}
		const query = dialect.sqlToQuery(promoRevenueSql(options, window))
		const [rows] = await connection.query(query.sql, query.params)
		const result = formatPromoRevenue(rows as PromoAggregateRow[], window)
		expect(result.byKind.find((row) => row.kind === 'evergreen')).toMatchObject(
			{
				recordCount: 2,
				purchaseCount: 2,
				gross: 37.75,
				refunds: 12.25,
				net: 25.5,
			},
		)
		expect(
			result.byKind.find((row) => row.kind === 'seat-or-zero'),
		).toMatchObject({
			recordCount: 2,
			purchaseCount: 0,
			gross: 0,
			refunds: 0,
			net: 0,
		})
	})

	it('uses exact millisecond [from,to) bounds, product filter and UTC daily grouping', async () => {
		await connection.query('DELETE FROM AI_Purchase')
		for (const [id, instant, product] of [
			['before', '2026-01-01T18:00:00.000Z', options.productId],
			['from', options.from, options.productId],
			[
				'last-ms-before-midnight',
				'2026-01-01T23:59:59.999Z',
				options.productId,
			],
			['utc-midnight', '2026-01-02T00:00:00Z', options.productId],
			['last-ms', '2026-01-02T18:00:00.000Z', options.productId],
			['to', options.to, options.productId],
			['other-product', options.from, 'synthetic-other'],
		])
			await connection.query(
				'INSERT INTO AI_Purchase VALUES (?, ?, FROM_UNIXTIME(?), ?, ?, NULL, NULL, NULL)',
				[id, product, Date.parse(instant!) / 1000, 'Valid', '10.25'],
			)
		const query = dialect.sqlToQuery(promoRevenueSql(options, window))
		const [rows] = await connection.query(query.sql, query.params)
		const result = formatPromoRevenue(rows as PromoAggregateRow[], window)
		expect(
			result.daily.map(({ date, purchaseCount, gross }) => ({
				date,
				purchaseCount,
				gross,
			})),
		).toEqual([
			{ date: '2026-01-01', purchaseCount: 2, gross: 20.5 },
			{ date: '2026-01-02', purchaseCount: 2, gross: 20.5 },
		])
		expect(
			result.byKind.find((row) => row.kind === 'full-price')?.purchaseCount,
		).toBe(4)
	})
})
