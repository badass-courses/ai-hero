import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ execute: vi.fn() }))
vi.mock('@/db', () => ({ db: { execute: mocks.execute } }))
vi.mock('@coursebuilder/analytics/providers/database', () => ({
	createDatabaseProvider: () => ({}),
}))
import { getRevenueByPromo } from './providers/database'

const options = { from: '2026-01-01T00:00:00Z', to: '2026-01-02T00:00:00Z' }
const row = {
	date: '2026-01-01',
	kind: 'evergreen',
	recordCount: '3',
	purchaseCount: 3n,
	gross: '75.50',
	refunds: '25.50',
}

describe('getRevenueByPromo mysql2 boundary', () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})
	it('unwraps [rows, fields] and decodes DECIMAL strings and bigint/string counts', async () => {
		mocks.execute.mockResolvedValue([[row], [{ name: 'gross' }]])
		const result = await getRevenueByPromo(options)
		expect(result.byKind.find((entry) => entry.kind === 'evergreen')).toEqual({
			kind: 'evergreen',
			currency: 'USD',
			recordCount: 3,
			purchaseCount: 3,
			gross: 75.5,
			refunds: 25.5,
			net: 50,
		})
	})
	it('also supports the pool legacy .rows shape', async () => {
		mocks.execute.mockResolvedValue({ rows: [row] })
		expect((await getRevenueByPromo(options)).daily[0]?.net).toBe(50)
	})
	it('accepts a genuine empty query result', async () => {
		mocks.execute.mockResolvedValue([[], []])
		expect(
			(await getRevenueByPromo(options)).byKind.every(
				(entry) => entry.recordCount === 0,
			),
		).toBe(true)
	})
	it.each([
		undefined,
		null,
		{},
		[],
		[{ affectedRows: 0 }, []],
		{ rows: null },
		[[{ ...row, gross: null }], []],
		[[{ ...row, purchaseCount: 'not-a-count' }], []],
	])('throws on unexpected driver or aggregate shape (#%#)', async (shape) => {
		mocks.execute.mockResolvedValue(shape)
		await expect(getRevenueByPromo(options)).rejects.toThrow(
			'Promo query returned',
		)
	})
})
