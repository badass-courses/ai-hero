import { drizzle } from 'drizzle-orm/mysql2'
import { describe, expect, it, vi } from 'vitest'

import * as schema from '@/db/schema'

import {
	formatRecentPurchases,
	formatShortlinkPerformance,
	getRecentPurchases,
	getShortlinkPerformance,
	recentPurchaseTeamFacts,
} from './database'

describe('shortlink performance ranking', () => {
	it('keeps SQL order, limits to twenty joined links, and ignores unrelated attribution', () => {
		const rows = Array.from({ length: 21 }, (_, index) => ({
			shortlinkId: `short_${index}`,
			slug: `slug-${index}`,
			url: `https://example.com/${index}`,
			clicks: 10,
		}))

		const result = formatShortlinkPerformance(rows, [
			{ shortlinkId: 'short_0', type: 'signup', count: 3 },
			{ shortlinkId: 'short_0', type: 'purchase', count: 1 },
			{ shortlinkId: 'deleted', type: 'purchase', count: 99 },
		])

		expect(result).toHaveLength(20)
		expect(result[0]).toMatchObject({
			shortlinkId: 'short_0',
			clicks: 10,
			signups: 3,
			purchases: 1,
		})
		expect(result.at(-1)?.shortlinkId).toBe('short_19')
		expect(result.map((row) => row.shortlinkId)).not.toContain('deleted')
	})

	it('uses aggregate-first SQL results and reads attribution only for selected IDs', async () => {
		const subquery = {
			from: vi.fn(),
			where: vi.fn(),
			groupBy: vi.fn(),
			as: vi.fn(),
		}
		subquery.from.mockReturnValue(subquery)
		subquery.where.mockReturnValue(subquery)
		subquery.groupBy.mockReturnValue(subquery)
		subquery.as.mockReturnValue({ shortlinkId: 'shortlink_id', clicks: 'clicks' })

		const rows = Array.from({ length: 21 }, (_, index) => ({
			shortlinkId: `short_${index}`,
			slug: `slug-${index}`,
			url: `https://example.com/${index}`,
			clicks: 10,
		}))
		const rankedQuery = {
			from: vi.fn(),
			innerJoin: vi.fn(),
			orderBy: vi.fn(),
			limit: vi.fn(),
		}
		rankedQuery.from.mockReturnValue(rankedQuery)
		rankedQuery.innerJoin.mockReturnValue(rankedQuery)
		rankedQuery.orderBy.mockReturnValue(rankedQuery)
		rankedQuery.limit.mockResolvedValue(rows)

		const attributionQuery = {
			from: vi.fn(),
			where: vi.fn(),
			groupBy: vi.fn(),
		}
		attributionQuery.from.mockReturnValue(attributionQuery)
		attributionQuery.where.mockReturnValue(attributionQuery)
		attributionQuery.groupBy.mockResolvedValue([
			{ shortlinkId: 'short_0', type: 'signup', count: 2 },
			{ shortlinkId: 'deleted', type: 'purchase', count: 50 },
		])

		const database = {
			select: vi
				.fn()
				.mockReturnValueOnce(subquery)
				.mockReturnValueOnce(rankedQuery)
				.mockReturnValueOnce(attributionQuery),
		}

		const result = await getShortlinkPerformance('30d', database as any)

		expect(database.select).toHaveBeenCalledTimes(3)
		expect(rankedQuery.orderBy).toHaveBeenCalledTimes(1)
		expect(rankedQuery.limit).toHaveBeenCalledWith(20)
		expect(result).toHaveLength(20)
		expect(result[0]?.shortlinkId).toBe('short_0')
		expect(result[0]?.signups).toBe(2)
		expect(result.map((row) => row.shortlinkId)).not.toContain('deleted')
	})
})

const purchaseRow = (
	id: string,
	bulkCouponId: string | null,
	bulkCouponMaxUses: number | null,
) => ({
	id,
	createdAt: new Date('2026-10-20T12:00:00.000Z'),
	totalAmount: '199.00',
	productName: 'Synthetic Cohort',
	productId: 'synthetic-product',
	country: 'US',
	couponId: null,
	userName: null,
	userEmail: null,
	bulkCouponId,
	bulkCouponMaxUses,
})

describe('recent purchase team facts', () => {
	it('reports an individual purchase as not a team', () => {
		expect(recentPurchaseTeamFacts(null, 0)).toEqual({
			isTeam: false,
			seats: null,
			teamSeats: null,
		})
	})

	it('reports a single-seat bulk coupon as not a team', () => {
		expect(recentPurchaseTeamFacts(1, 1)).toEqual({
			isTeam: false,
			seats: null,
			teamSeats: null,
		})
	})

	it('reports seats for the only purchase on a team coupon', () => {
		expect(recentPurchaseTeamFacts(5, 1)).toEqual({
			isTeam: true,
			seats: 5,
			teamSeats: 5,
		})
	})

	it('leaves seats unknown for an add-seat team', () => {
		expect(recentPurchaseTeamFacts(8, 3)).toEqual({
			isTeam: true,
			seats: null,
			teamSeats: 8,
		})
	})

	it('maps every row kind from the page and coupon counts', () => {
		const result = formatRecentPurchases(
			[
				// Organization-only cohort checkout: no bulk coupon on the row.
				purchaseRow('synthetic-org-only', null, null),
				purchaseRow('synthetic-single-seat', 'synthetic-coupon-one', 1),
				purchaseRow('synthetic-team', 'synthetic-coupon-team', 4),
				purchaseRow('synthetic-add-seat', 'synthetic-coupon-grown', 6),
			],
			[
				{ bulkCouponId: 'synthetic-coupon-team', purchases: 1 },
				{ bulkCouponId: 'synthetic-coupon-grown', purchases: BigInt(2) },
			],
		)

		expect(
			result.map(({ id, isTeam, seats, teamSeats }) => ({
				id,
				isTeam,
				seats,
				teamSeats,
			})),
		).toEqual([
			{ id: 'synthetic-org-only', isTeam: false, seats: null, teamSeats: null },
			{
				id: 'synthetic-single-seat',
				isTeam: false,
				seats: null,
				teamSeats: null,
			},
			{ id: 'synthetic-team', isTeam: true, seats: 4, teamSeats: 4 },
			{ id: 'synthetic-add-seat', isTeam: true, seats: null, teamSeats: 6 },
		])
		expect(result[0]).toMatchObject({
			totalAmount: 199,
			productName: 'Synthetic Cohort',
		})
	})
})

/**
 * Real drizzle builders over a mock driver: every awaited query records its
 * compiled SQL and resolves to the next canned result instead of executing.
 */
function capturingDatabase(results: unknown[][]) {
	const statements: { sql: string; params: unknown[] }[] = []
	const mock = drizzle.mock({ schema, mode: 'default' })
	const wrap = (builder: any): any =>
		new Proxy(builder, {
			get(target, prop) {
				if (prop === 'then') {
					return (resolve: any, reject: any) => {
						statements.push(target.toSQL())
						return Promise.resolve(results.shift() ?? []).then(resolve, reject)
					}
				}
				const value = Reflect.get(target, prop, target)
				if (typeof value !== 'function') return value
				return (...args: unknown[]) => {
					const out = value.apply(target, args)
					return out && typeof out.toSQL === 'function' ? wrap(out) : out
				}
			},
		})
	return {
		statements,
		database: { select: (fields: any) => wrap(mock.select(fields)) },
	}
}

describe('getRecentPurchases', () => {
	it('joins the bulk coupon, keeps order and paging, and counts only page team coupons', async () => {
		const { database, statements } = capturingDatabase([
			[
				purchaseRow('synthetic-add-seat', 'synthetic-coupon-grown', 6),
				purchaseRow('synthetic-team', 'synthetic-coupon-team', 4),
				purchaseRow('synthetic-single-seat', 'synthetic-coupon-one', 1),
				purchaseRow('synthetic-org-only', null, null),
			],
			[
				{ bulkCouponId: 'synthetic-coupon-grown', purchases: 3 },
				{ bulkCouponId: 'synthetic-coupon-team', purchases: 1 },
			],
		])

		const result = await getRecentPurchases(
			4,
			'all',
			'7d',
			{ productId: 'synthetic-product', offset: 8 },
			database as any,
		)

		expect(statements).toHaveLength(2)
		const [page, counts] = statements
		expect(page!.sql).toMatch(/left join `AI_Coupon` on `AI_Purchase`.`bulkCouponId` = `AI_Coupon`.`id`/)
		expect(page!.sql).toMatch(
			/order by `AI_Purchase`.`createdAt` desc, `AI_Purchase`.`id` desc limit \? offset \?$/,
		)
		expect(page!.sql).toContain('`AI_Purchase`.`createdAt` >= ?')
		expect(page!.sql).toContain('`AI_Purchase`.`productId` = ?')
		expect(page!.sql).not.toContain('`AI_Coupon`.`maxUses` >')
		expect(page!.params).toEqual(
			expect.arrayContaining(['Valid', 'Restricted', 'synthetic-product', 4, 8]),
		)
		expect(counts!.sql).toMatch(
			/where `AI_Purchase`.`bulkCouponId` in \(\?, \?\) group by `AI_Purchase`.`bulkCouponId`$/,
		)
		expect(counts!.params).toEqual([
			'synthetic-coupon-grown',
			'synthetic-coupon-team',
		])
		expect(
			result.map(({ id, isTeam, seats, teamSeats }) => [
				id,
				isTeam,
				seats,
				teamSeats,
			]),
		).toEqual([
			['synthetic-add-seat', true, null, 6],
			['synthetic-team', true, 4, 4],
			['synthetic-single-seat', false, null, null],
			['synthetic-org-only', false, null, null],
		])
	})

	it('filters team purchases by a multi-seat bulk coupon', async () => {
		const { database, statements } = capturingDatabase([[]])

		await getRecentPurchases(20, 'team', 'all', {}, database as any)

		expect(statements).toHaveLength(1)
		expect(statements[0]!.sql).toContain('`AI_Coupon`.`maxUses` > ?')
		expect(statements[0]!.sql).not.toContain('`AI_Purchase`.`createdAt` >= ?')
	})

	it('filters individual purchases as everything that is not a team', async () => {
		const { database, statements } = capturingDatabase([
			[purchaseRow('synthetic-single-seat', 'synthetic-coupon-one', 1)],
		])

		const result = await getRecentPurchases(
			20,
			'individual',
			'all',
			{},
			database as any,
		)

		expect(statements).toHaveLength(1)
		expect(statements[0]!.sql).toContain(
			'(`AI_Purchase`.`bulkCouponId` is null or `AI_Coupon`.`maxUses` is null or `AI_Coupon`.`maxUses` <= ?)',
		)
		expect(result[0]).toMatchObject({ isTeam: false, seats: null, teamSeats: null })
	})
})
