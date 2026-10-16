import { describe, expect, it } from 'vitest'
import { getTableConfig } from 'drizzle-orm/mysql-core'
import { purchases, coupon, merchantCoupon } from '@/db/schema'
import { PROMO_FIXTURE_TABLES, promoFixtureDdl } from './promos-fixture-schema'

describe('promo fixture matches Drizzle commerce schema', () => {
	it.each([purchases, coupon, merchantCoupon])(
		'checks the table and projected column SQL types',
		(table) => {
			const config = getTableConfig(table)
			const fixture =
				PROMO_FIXTURE_TABLES[config.name as keyof typeof PROMO_FIXTURE_TABLES]
			expect(fixture).toBeDefined()
			for (const [name, type] of Object.entries(fixture)) {
				const column = config.columns.find((column) => column.name === name)
				expect(column, `${config.name}.${name}`).toBeDefined()
				expect(column!.getSQLType().replaceAll(' ', '').toLowerCase()).toBe(
					type,
				)
			}
			expect(
				promoFixtureDdl.some((ddl) =>
					ddl.startsWith(`CREATE TABLE \`${config.name}\``),
				),
			).toBe(true)
		},
	)
	it('records actual NOT NULL status/amount and millisecond TIMESTAMP storage', () => {
		expect(purchases.status.notNull).toBe(true)
		expect(purchases.totalAmount.notNull).toBe(true)
		expect(purchases.createdAt.getSQLType()).toBe('timestamp(3)')
	})
	it('allows a merchant coupon reference at the storage level: same varchar type, no enforcing FK', () => {
		expect(purchases.couponId.notNull).toBe(false)
		expect(purchases.couponId.getSQLType()).toBe(merchantCoupon.id.getSQLType())
		const enforcingForeignKeys = getTableConfig(purchases).foreignKeys.filter(
			(key) => key.reference().columns.includes(purchases.couponId),
		)
		expect(enforcingForeignKeys).toEqual([])
	})
	it('makes the missing time indexes explicit instead of claiming an index exists', () => {
		const indexes = getTableConfig(purchases).indexes
		const columns = indexes.map((index) =>
			index.config.columns.map((column) =>
				'name' in column ? column.name : null,
			),
		)
		expect(
			columns.some(
				(names) =>
					names[0] === 'createdAt' ||
					(names[0] === 'productId' && names[1] === 'createdAt'),
			),
		).toBe(false)
	})
})
