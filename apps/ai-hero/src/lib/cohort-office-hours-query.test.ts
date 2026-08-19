import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	select: vi.fn(),
	from: vi.fn(),
	innerJoin: vi.fn(),
	where: vi.fn(),
	limit: vi.fn(),
}))

vi.mock('@/db', () => ({
	db: { select: mocks.select },
}))

import { getCohortOfficeHoursSessionsForWorkshop } from './cohort-office-hours-query'

const session = {
	title: 'AI Coding for Real Engineers Office Hours',
	startsAt: '2026-06-01T08:30:00Z',
	endsAt: '2026-06-01T09:15:00Z',
	youtubeBroadcastId: 'recording-1',
	youtubeWatchUrl: 'https://www.youtube.com/watch?v=recording-1',
}

describe('getCohortOfficeHoursSessionsForWorkshop', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.select.mockReturnValue({ from: mocks.from })
		mocks.from.mockReturnValue({ innerJoin: mocks.innerJoin })
		mocks.innerJoin.mockReturnValue({ where: mocks.where })
		mocks.where.mockReturnValue({ limit: mocks.limit })
	})

	it('returns schema-checked sessions from a joined cohort and workshop row', async () => {
		mocks.limit.mockResolvedValue([{ sessions: JSON.stringify([session]) }])

		const sessions = await getCohortOfficeHoursSessionsForWorkshop({
			cohortId: 'cohort-1',
			authorizedWorkshopId: 'workshop-1',
		})

		expect(mocks.innerJoin).toHaveBeenCalledOnce()
		expect(mocks.limit).toHaveBeenCalledWith(1)
		expect(sessions).toEqual([session])
	})

	it('returns no recording data when the cohort-workshop join finds no row', async () => {
		mocks.limit.mockResolvedValue([])

		const sessions = await getCohortOfficeHoursSessionsForWorkshop({
			cohortId: 'different-cohort',
			authorizedWorkshopId: 'workshop-1',
		})

		expect(sessions).toEqual([])
	})

	it('rejects malformed session data at the database boundary', async () => {
		mocks.limit.mockResolvedValue([
			{ sessions: JSON.stringify([{ ...session, youtubeWatchUrl: 'nope' }]) },
		])

		const sessions = await getCohortOfficeHoursSessionsForWorkshop({
			cohortId: 'cohort-1',
			authorizedWorkshopId: 'workshop-1',
		})

		expect(sessions).toEqual([])
	})
})
