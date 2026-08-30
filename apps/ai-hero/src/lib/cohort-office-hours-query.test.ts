import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	getAbilityForResource: vi.fn(),
	select: vi.fn(),
	from: vi.fn(),
	innerJoin: vi.fn(),
	where: vi.fn(),
	limit: vi.fn(),
	isNull: vi.fn(),
}))

vi.mock('@/db', () => ({
	db: { select: mocks.select },
}))

vi.mock('@/utils/get-current-ability-rules', () => ({
	getAbilityForResource: mocks.getAbilityForResource,
}))

vi.mock('drizzle-orm', async () => {
	const actual = await vi.importActual<typeof import('drizzle-orm')>(
		'drizzle-orm',
	)

	return {
		...actual,
		isNull: (column: unknown) => {
			mocks.isNull(column)
			return actual.isNull(column as Parameters<typeof actual.isNull>[0])
		},
	}
})

import { contentResourceResource } from '@/db/schema'

import { getCohortOfficeHoursSessionsForWorkshop } from './cohort-office-hours-query'

const session = {
	title: 'AI Coding for Real Engineers Office Hours',
	startsAt: '2026-06-01T08:30:00Z',
	endsAt: '2026-06-01T09:15:00Z',
	youtubeBroadcastId: 'recording-1',
	youtubeWatchUrl: 'https://www.youtube.com/watch?v=recording-1',
}

const sixSessions = Array.from({ length: 6 }, (_, index) => ({
	...session,
	title: `${session.title} ${index + 1}`,
	youtubeBroadcastId: `recording-${index + 1}`,
	youtubeWatchUrl: `https://www.youtube.com/watch?v=recording-${index + 1}`,
}))

describe('getCohortOfficeHoursSessionsForWorkshop', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.getAbilityForResource.mockResolvedValue({ canViewWorkshop: true })
		mocks.select.mockReturnValue({ from: mocks.from })
		mocks.from.mockReturnValue({ innerJoin: mocks.innerJoin })
		mocks.innerJoin.mockReturnValue({ where: mocks.where })
		mocks.where.mockReturnValue({ limit: mocks.limit })
	})

	it('returns all six sessions for a purchaser with protected workshop access', async () => {
		mocks.limit.mockResolvedValue([
			{ sessions: JSON.stringify(sixSessions) },
		])

		const sessions = await getCohortOfficeHoursSessionsForWorkshop({
			cohortId: 'cohort-1',
			workshopId: 'workshop-1',
		})

		expect(mocks.getAbilityForResource).toHaveBeenCalledWith(
			undefined,
			'workshop-1',
		)
		expect(sessions).toEqual(sixSessions)
	})

	it('returns no cohort data for an anonymous free-lesson viewer', async () => {
		mocks.getAbilityForResource.mockResolvedValue({
			canViewLesson: true,
			canViewWorkshop: false,
		})

		const sessions = await getCohortOfficeHoursSessionsForWorkshop({
			cohortId: 'cohort-1',
			workshopId: 'workshop-1',
		})

		expect(sessions).toEqual([])
		expect(mocks.select).not.toHaveBeenCalled()
	})

	it('allows the explicit reviewer workshop-read path', async () => {
		mocks.getAbilityForResource.mockResolvedValue({ canViewWorkshop: true })
		mocks.limit.mockResolvedValue([{ sessions: JSON.stringify([session]) }])

		const sessions = await getCohortOfficeHoursSessionsForWorkshop({
			cohortId: 'cohort-1',
			workshopId: 'workshop-1',
		})

		expect(sessions).toEqual([session])
	})

	it('returns no sessions for a soft-deleted cohort-workshop relation', async () => {
		// The mocked database has only a tombstoned relation, so the active-link
		// predicate must exclude it and produce no selected row.
		mocks.limit.mockResolvedValue([])

		const sessions = await getCohortOfficeHoursSessionsForWorkshop({
			cohortId: 'cohort-1',
			workshopId: 'workshop-1',
		})

		expect(mocks.isNull).toHaveBeenCalledWith(
			contentResourceResource.deletedAt,
		)
		expect(sessions).toEqual([])
	})

	it('returns no recording data when the active cohort-workshop join finds no row', async () => {
		mocks.limit.mockResolvedValue([])

		const sessions = await getCohortOfficeHoursSessionsForWorkshop({
			cohortId: 'different-cohort',
			workshopId: 'workshop-1',
		})

		expect(sessions).toEqual([])
	})

	it('rejects malformed session data at the database boundary', async () => {
		mocks.limit.mockResolvedValue([
			{ sessions: JSON.stringify([{ ...session, youtubeWatchUrl: 'nope' }]) },
		])

		const sessions = await getCohortOfficeHoursSessionsForWorkshop({
			cohortId: 'cohort-1',
			workshopId: 'workshop-1',
		})

		expect(sessions).toEqual([])
	})
})
