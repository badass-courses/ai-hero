import { describe, expect, it } from 'vitest'
import { MySqlDialect } from 'drizzle-orm/mysql-core'
import {
	EVERGREEN_FUNNEL_PENDING,
	formatPromoRevenue,
	PROMO_KINDS,
	promoKindOf,
	promoWindow,
} from './promos'
import { promoCases } from './promos.fixtures'
import { promoRevenueSql } from './promos-query'

describe('promoKindOf exhaustive decision table', () => {
	it.each(promoCases)('$name -> $kind', ({ purchase, facts, kind }) => {
		expect(promoKindOf(purchase, facts)).toBe(kind)
	})
	it('covers every declared kind so new kinds cannot fall through uncounted', () => {
		expect([...new Set(promoCases.map((row) => row.kind))].sort()).toEqual(
			[...PROMO_KINDS].sort(),
		)
	})
	it('fails closed for malformed amounts', () => {
		expect(promoKindOf({ status: 'Valid', totalAmount: 'NaN' }, {})).toBe(
			'unclassified',
		)
	})
})

describe('promo window and money', () => {
	const options = {
		from: '2026-01-01T18:00:00.001Z',
		to: '2026-01-03T18:00:00Z',
		productId: 'synthetic-product',
	}
	it('preserves exact half-open UTC instants', () => {
		expect(promoWindow(options)).toMatchObject({
			from: options.from,
			to: '2026-01-03T18:00:00.000Z',
			bounds: '[from,to)',
		})
	})
	it.each([
		{ from: options.from },
		{ to: options.to },
		{ from: options.to, to: options.from },
		{ from: '2026-02-30T00:00:00Z', to: options.to },
		{ from: '2026-01-01', to: options.to },
		{ from: '2026-01-01T00:00:00-08:00', to: options.to },
		{ from: '2026-01-01T00:00:00.0001Z', to: options.to },
		{ from: '2024-01-01T00:00:00Z', to: options.to },
	])('rejects invalid explicit windows %j', (input) =>
		expect(() => promoWindow(input)).toThrow(),
	)
	it('uses bounded rolling ranges and rejects all with an actionable prompt', () => {
		const now = new Date('2026-01-31T18:00:00Z')
		expect(promoWindow({ range: '30d' }, now).from).toBe(
			'2026-01-01T18:00:00.000Z',
		)
		expect(() => promoWindow({ range: 'all' }, now)).toThrow(
			'range=all is not supported',
		)
		expect(() =>
			promoWindow({ from: '2024-01-01T00:00:00Z', to: '2025-02-04T00:00:00Z' }),
		).not.toThrow()
		expect(() =>
			promoWindow({ from: '2024-01-01T00:00:00Z', to: '2025-02-05T00:00:00Z' }),
		).toThrow('400 days')
	})
	it('subtracts refunds and preserves all kinds including empty and unclassified', () => {
		const result = formatPromoRevenue(
			[
				{
					date: '2026-01-01',
					kind: 'evergreen',
					recordCount: '3',
					purchaseCount: '3',
					gross: '75.50',
					refunds: '25.50',
				},
				{
					date: '2026-01-02',
					kind: 'evergreen',
					recordCount: 1,
					purchaseCount: 1,
					gross: '12.25',
					refunds: 0,
				},
				{
					date: '2026-01-02',
					kind: 'unclassified',
					recordCount: 1,
					purchaseCount: 0,
					gross: 0,
					refunds: 0,
				},
			],
			promoWindow(options),
		)
		expect(result.byKind.find((row) => row.kind === 'evergreen')).toMatchObject(
			{
				currency: 'USD',
				recordCount: 4,
				purchaseCount: 4,
				gross: 87.75,
				refunds: 25.5,
				net: 62.25,
			},
		)
		expect(result.byKind).toHaveLength(PROMO_KINDS.length)
		expect(result.daily[0]?.net).toBe(50)
		expect(
			result.byKind.find((row) => row.kind === 'unclassified')?.recordCount,
		).toBe(1)
		expect(
			formatPromoRevenue([], promoWindow(options)).byKind.every(
				(row) => row.net === 0,
			),
		).toBe(true)
	})
	it('rejects a new SQL kind instead of dropping it', () => {
		expect(() =>
			formatPromoRevenue(
				[
					{
						kind: 'future-kind',
						date: '2026-01-01',
						recordCount: 1,
						purchaseCount: 1,
						gross: 1,
						refunds: 0,
					} as any,
				],
				promoWindow(options),
			),
		).toThrow('Unexpected promo kind')
	})
	it('compiles a grouped bound SQL query without customer fields', () => {
		const query = new MySqlDialect().sqlToQuery(
			promoRevenueSql(options, promoWindow(options)),
		)
		expect(query.sql).toContain('GROUP BY date, kind')
		expect(query.sql).toContain('p.createdAt < FROM_UNIXTIME(? / 1000)')
		expect(query.sql).toContain('p.createdAt >= FROM_UNIXTIME(? / 1000)')
		expect(query.sql).not.toContain(options.productId)
		expect(query.params).toContain(options.productId)
		expect(query.params).toContain(Date.parse(options.from))
		expect(query.params).toContain(Date.parse(options.to))
		expect(query.sql).toContain('FLOOR(UNIX_TIMESTAMP(p.createdAt))')
		expect(query.sql).toContain('BINARY p.status')
		expect(query.sql).not.toMatch(/email|userId|userName/i)
	})
	it('returns typed pending, never fabricated conversion counts', () => {
		expect(EVERGREEN_FUNNEL_PENDING).toEqual({
			status: 'pending',
			reason: expect.any(String),
		})
	})
})
