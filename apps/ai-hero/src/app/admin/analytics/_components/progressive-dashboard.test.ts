import { describe, expect, it } from 'vitest'

import {
	DASHBOARD_SECTIONS,
	createEmptyDashboardData,
	isCurrentDashboardResponse,
	mergeDashboardSection,
	type DashboardSection,
} from '@/lib/analytics/dashboard-contract'

import { createSectionRequestQueue } from './progressive-dashboard-queue'

const revenue = {
	summary: { totalRevenue: 199, purchaseCount: 1, avgOrderValue: 199 },
}

const shortlinks = {
	shortlinks: [
		{
			shortlinkId: 'short_1',
			slug: 'launch',
			url: 'https://example.com',
			clicks: 12,
			signups: 2,
			purchases: 1,
		},
	],
}

describe('progressive analytics dashboard contract', () => {
	it('keeps a response from an old range out of the active dashboard', () => {
		expect(
			isCurrentDashboardResponse({
				responseRange: '30d',
				activeRange: '7d',
				responseGeneration: 1,
				activeGeneration: 2,
			}),
		).toBe(false)
		expect(
			isCurrentDashboardResponse({
				responseRange: '7d',
				activeRange: '7d',
				responseGeneration: 2,
				activeGeneration: 2,
			}),
		).toBe(true)
	})

	it('merges independently ready sections without turning failures into zeroes', () => {
		const afterRevenue = mergeDashboardSection(
			createEmptyDashboardData(),
			'summary',
			revenue,
		)
		const afterShortlinks = mergeDashboardSection(
			afterRevenue,
			'shortlinks',
			shortlinks,
		)

		expect(afterShortlinks.summary).toEqual(revenue.summary)
		expect(afterShortlinks.shortlinks).toEqual(shortlinks.shortlinks)
		expect(afterShortlinks.daily).toEqual([])
	})

	it('defines a bounded queue with revenue before optional providers', () => {
		expect(DASHBOARD_SECTIONS[0]).toBe('summary')
		expect(DASHBOARD_SECTIONS).toContain('shortlinks')
		expect(DASHBOARD_SECTIONS).toContain('value-paths')
		expect(DASHBOARD_SECTIONS.length).toBeGreaterThan(4)
	})

	it('keeps five rapid retry requests at two active fetches', async () => {
		let active = 0
		let maximumActive = 0
		const started: string[] = []
		const releases: Array<() => void> = []
		const queue = createSectionRequestQueue(async ({ section }) => {
			active += 1
			maximumActive = Math.max(maximumActive, active)
			started.push(section)
			await new Promise<void>((resolve) => releases.push(resolve))
			active -= 1
		}, 2)

		for (const section of DASHBOARD_SECTIONS.slice(1, 6)) {
			queue.enqueue({ section, range: '30d', generation: 1 })
		}
		await new Promise((resolve) => setTimeout(resolve, 0))
		expect(started).toHaveLength(2)
		expect(maximumActive).toBe(2)

		while (started.length < 5) {
			for (const release of releases.splice(0)) release()
			await new Promise((resolve) => setTimeout(resolve, 0))
		}
		for (const release of releases.splice(0)) release()
		await new Promise((resolve) => setTimeout(resolve, 0))
		expect(started).toHaveLength(5)
		expect(maximumActive).toBeLessThanOrEqual(2)
	})
})
