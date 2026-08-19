import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	getCohortOfficeHoursSessionsForWorkshop: vi.fn(),
	warn: vi.fn(),
}))

vi.mock('@/lib/cohort-office-hours-query', () => ({
	getCohortOfficeHoursSessionsForWorkshop:
		mocks.getCohortOfficeHoursSessionsForWorkshop,
}))

vi.mock('@/server/logger', () => ({
	log: { warn: mocks.warn },
}))

import { AuthorizedOfficeHoursSchedule } from './authorized-office-hours-schedule'

const session = {
	title: 'AI Coding for Real Engineers Office Hours',
	startsAt: '2026-06-01T08:30:00Z',
	endsAt: '2026-06-01T09:15:00Z',
	youtubeBroadcastId: 'recording-1',
	youtubeWatchUrl: 'https://www.youtube.com/watch?v=recording-1',
}

describe('AuthorizedOfficeHoursSchedule', () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it('renders the server-resolved recording for an authorized workshop lesson', async () => {
		mocks.getCohortOfficeHoursSessionsForWorkshop.mockResolvedValue([session])

		const schedule = await AuthorizedOfficeHoursSchedule({
			cohortId: 'cohort-1',
			authorizedWorkshopId: 'workshop-1',
			timeZone: 'UTC',
			timeZoneLabel: 'UTC',
		})
		const markup = renderToStaticMarkup(schedule)

		expect(mocks.getCohortOfficeHoursSessionsForWorkshop).toHaveBeenCalledWith({
			cohortId: 'cohort-1',
			authorizedWorkshopId: 'workshop-1',
		})
		expect(markup).toContain('Watch Replay')
		expect(markup).toContain(
			'href="https://www.youtube.com/watch?v=recording-1"',
		)
	})

	it('returns nothing and reads no cohort data without authorized lesson context', async () => {
		const schedule = await AuthorizedOfficeHoursSchedule({
			cohortId: 'cohort-1',
			timeZone: 'UTC',
		})

		expect(schedule).toBeNull()
		expect(
			mocks.getCohortOfficeHoursSessionsForWorkshop,
		).not.toHaveBeenCalled()
	})

	it('keeps a cohort lookup failure local to the MDX component', async () => {
		mocks.getCohortOfficeHoursSessionsForWorkshop.mockRejectedValue(
			new Error('database unavailable'),
		)

		const schedule = await AuthorizedOfficeHoursSchedule({
			cohortId: 'cohort-1',
			authorizedWorkshopId: 'workshop-1',
			timeZone: 'UTC',
		})

		expect(schedule).toBeNull()
		expect(mocks.warn).toHaveBeenCalledWith(
			'cohort.office-hours.resolve.failed',
			expect.objectContaining({
				cohortId: 'cohort-1',
				authorizedWorkshopId: 'workshop-1',
				error: 'database unavailable',
			}),
		)
	})
})
