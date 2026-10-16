import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ getRevenueByPromo: vi.fn() }))
vi.mock('./providers/database', () => ({
	getRevenueByPromo: mocks.getRevenueByPromo,
}))
vi.mock('./providers/derived', () => ({}))
vi.mock('./providers/newsletter', () => ({}))
vi.mock('./providers/ga4', () => ({}))
vi.mock('./providers/survey', () => ({}))
vi.mock('./providers/youtube', () => ({}))
import { getCatalog, query, queryMany } from './index'

describe('local promo engine extension', () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})
	it('discovers both extensions alongside the upstream catalog', () => {
		expect(getCatalog().map((entry) => entry.name)).toEqual(
			expect.arrayContaining(['summary', 'revenue/promos', 'funnel/evergreen']),
		)
	})
	it('forwards exact filters to the database provider', async () => {
		const options = {
			from: '2026-01-01T00:00:00Z',
			to: '2026-01-02T00:00:00Z',
			productId: 'synthetic',
		}
		mocks.getRevenueByPromo.mockResolvedValue({
			currency: 'USD',
			byKind: [],
			daily: [],
		})
		expect(await query('revenue/promos', options)).toMatchObject({
			ok: true,
			meta: { truncated: false },
		})
		expect(mocks.getRevenueByPromo).toHaveBeenCalledWith(options)
	})
	it('pending funnel does not read purchase or external providers', async () => {
		const result = await queryMany(['funnel/evergreen'])
		expect(result['funnel/evergreen']).toMatchObject({
			ok: true,
			data: { status: 'pending', reason: expect.any(String) },
		})
		expect(mocks.getRevenueByPromo).not.toHaveBeenCalled()
	})
	it('does not leak database errors or identifiers', async () => {
		mocks.getRevenueByPromo.mockRejectedValue(
			new Error('synthetic-private-internal-detail'),
		)
		const result = await query('revenue/promos')
		expect(result.ok).toBe(false)
		expect(JSON.stringify(result)).not.toContain(
			'synthetic-private-internal-detail',
		)
	})
})
