import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({
	getRevenueByPromo: vi.fn(),
	getLearningProgress: vi.fn(),
	baseQuery: vi.fn(),
	baseQueryMany: vi.fn(),
	baseGetCatalog: vi.fn(() => [{ name: 'summary' }]),
	errorLog: vi.fn(),
}))
vi.mock('@coursebuilder/analytics/engine', () => ({
	createAnalyticsEngine: () => ({
		query: mocks.baseQuery,
		queryMany: mocks.baseQueryMany,
		getCatalog: mocks.baseGetCatalog,
	}),
}))
vi.mock('@/server/logger', () => ({ log: { error: mocks.errorLog } }))
vi.mock('./providers/database', () => ({
	getRevenueByPromo: mocks.getRevenueByPromo,
	getLearningProgress: mocks.getLearningProgress,
}))
vi.mock('@/db', () => ({}))
vi.mock('./providers/derived', () => ({}))
vi.mock('./providers/newsletter', () => ({}))
vi.mock('./providers/ga4', () => ({}))
vi.mock('./providers/survey', () => ({}))
vi.mock('./providers/youtube', () => ({}))
import { getCatalog, query, queryMany } from './index'
import { LearningProductNotFoundError } from './learning-progress-query'

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
	it('delegates base query and queryMany without changing their results', async () => {
		const result = {
			summary: { ok: true, surface: 'summary', data: { totalRevenue: 25 } },
		}
		mocks.baseQuery.mockResolvedValue(result.summary)
		mocks.baseQueryMany.mockResolvedValue(result)
		const options = { range: 'all' as const }
		expect(await query('summary', options)).toBe(result.summary)
		expect(mocks.baseQuery).toHaveBeenCalledWith('summary', options)
		expect(await queryMany(['summary'], options)).toEqual(result)
		expect(mocks.baseQueryMany).toHaveBeenCalledWith(['summary'], options)
		getCatalog()
		expect(mocks.baseGetCatalog).toHaveBeenCalled()
	})

	it('combines base queryMany with only the local promo surfaces', async () => {
		mocks.baseQueryMany.mockResolvedValue({
			summary: { ok: true, surface: 'summary' },
		})
		const result = await queryMany(['summary', 'funnel/evergreen'])
		expect(mocks.baseQueryMany).toHaveBeenCalledWith(['summary'], undefined)
		expect(result.summary).toMatchObject({ ok: true })
		expect(result['funnel/evergreen']).toMatchObject({
			data: { status: 'pending' },
		})
	})

	it('does not leak database errors or identifiers', async () => {
		mocks.getRevenueByPromo.mockRejectedValue(
			new Error('synthetic-private-internal-detail'),
		)
		const result = await query('revenue/promos')
		expect(result.ok).toBe(false)
		expect(mocks.errorLog).toHaveBeenCalledWith(
			'analytics.promo.query-failed',
			{ surface: 'revenue/promos', error: expect.any(Error) },
		)
		expect(JSON.stringify(result)).not.toContain(
			'synthetic-private-internal-detail',
		)
	})

	it('requires a productId for learning progress before reading', async () => {
		const result = await query('learning/progress', { range: '7d' })
		expect(result).toMatchObject({
			ok: false,
			error: { code: 'PRODUCT_REQUIRED' },
		})
		expect(mocks.getLearningProgress).not.toHaveBeenCalled()
		expect(getCatalog().map((entry) => entry.name)).toContain(
			'learning/progress',
		)
	})

	it('reads learning progress through the cached provider', async () => {
		mocks.getLearningProgress.mockResolvedValue({ asOf: 'synthetic' })
		expect(
			await query('learning/progress', { productId: 'synthetic' }),
		).toMatchObject({ ok: true, data: { asOf: 'synthetic' } })
		expect(mocks.getLearningProgress).toHaveBeenCalledWith('synthetic')
	})

	it('maps an unknown product and hides other learning errors', async () => {
		mocks.getLearningProgress.mockRejectedValueOnce(
			new LearningProductNotFoundError(),
		)
		expect(
			await query('learning/progress', { productId: 'missing' }),
		).toMatchObject({ ok: false, error: { code: 'PRODUCT_NOT_FOUND' } })
		mocks.getLearningProgress.mockRejectedValueOnce(
			new Error('synthetic-private-internal-detail'),
		)
		const result = await query('learning/progress', { productId: 'synthetic' })
		expect(result).toMatchObject({ ok: false, error: { code: 'QUERY_FAILED' } })
		expect(JSON.stringify(result)).not.toContain(
			'synthetic-private-internal-detail',
		)
	})
})
