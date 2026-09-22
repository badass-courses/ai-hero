import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	getRevenueSummary: vi.fn(),
}))

vi.mock('next/cache', () => ({
	unstable_cache: (fn: (...args: any[]) => unknown) => fn,
}))
vi.mock('@/lib/analytics/providers/database', () => ({
	getRevenueSummary: mocks.getRevenueSummary,
	getPreviousPeriodRevenueByDay: vi.fn(),
	getRecentPurchases: vi.fn(),
	getRevenueByCountry: vi.fn(),
	getRevenueByDay: vi.fn(),
	getRevenueByProduct: vi.fn(),
	getAttributionSummary: vi.fn(),
	getShortlinkPerformance: vi.fn(),
	getAttributedRevenueSummary: vi.fn(),
}))
vi.mock('@/lib/analytics', () => ({
	query: vi.fn(),
}))
vi.mock('@/lib/mux-data', () => ({
	getVideoDashboardData: vi.fn(),
	getVideoThumbnails: vi.fn(),
}))

import { loadDashboardSection } from './dashboard-sections'

const summary = { totalRevenue: 199, purchaseCount: 1, avgOrderValue: 199 }

beforeEach(() => {
	vi.clearAllMocks()
	mocks.getRevenueSummary.mockResolvedValue(summary)
})

describe('dashboard section in-flight sharing', () => {
	it('shares identical section/range work and evicts failed work for retry', async () => {
		let release!: (value: typeof summary) => void
		mocks.getRevenueSummary.mockImplementationOnce(
			() => new Promise((resolve) => (release = resolve)),
		)

		const first = loadDashboardSection('summary', '30d')
		const second = loadDashboardSection('summary', '30d')
		await Promise.resolve()
		expect(mocks.getRevenueSummary).toHaveBeenCalledTimes(1)

		release(summary)
		expect(await Promise.all([first, second])).toEqual([
			{ summary },
			{ summary },
		])

		mocks.getRevenueSummary.mockRejectedValueOnce(new Error('database EOF'))
		await expect(loadDashboardSection('summary', '30d')).rejects.toThrow(
			'database EOF',
		)
		await expect(loadDashboardSection('summary', '30d')).resolves.toEqual({
			summary,
		})
		expect(mocks.getRevenueSummary).toHaveBeenCalledTimes(3)
	})

	it('lets one aborted caller leave shared work for another caller', async () => {
		let release!: (value: typeof summary) => void
		mocks.getRevenueSummary.mockImplementation(
			() => new Promise((resolve) => (release = resolve)),
		)
		const controller = new AbortController()
		const aborted = loadDashboardSection('summary', '7d', {
			signal: controller.signal,
		})
		const survivor = loadDashboardSection('summary', '7d')
		controller.abort()

		await expect(aborted).rejects.toMatchObject({ name: 'AbortError' })
		expect(mocks.getRevenueSummary).toHaveBeenCalledTimes(1)
		release(summary)
		await expect(survivor).resolves.toEqual({ summary })
	})
})
