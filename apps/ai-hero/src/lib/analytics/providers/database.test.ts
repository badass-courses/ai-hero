import { describe, expect, it, vi } from 'vitest'

import {
	formatShortlinkPerformance,
	getShortlinkPerformance,
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
