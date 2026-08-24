import { renderToReadableStream } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	getCohortOfficeHoursSessionsForWorkshop: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
}))

vi.mock('@/lib/cohort-office-hours-query', () => ({
	getCohortOfficeHoursSessionsForWorkshop:
		mocks.getCohortOfficeHoursSessionsForWorkshop,
}))

vi.mock('@/server/logger', () => ({
	log: {
		warn: mocks.warn,
		error: mocks.error,
		debug: vi.fn(),
	},
}))

vi.mock('@/server/auth', () => ({
	getServerAuthSession: vi.fn(),
}))

import { compileMDX } from './compile-mdx'

const session = {
	title: 'AI Coding for Real Engineers Office Hours',
	startsAt: '2026-06-01T08:30:00Z',
	endsAt: '2026-06-01T09:15:00Z',
	youtubeBroadcastId: 'recording-1',
	youtubeWatchUrl: 'https://www.youtube.com/watch?v=recording-1',
}

async function renderOfficeHoursMdx(
	source: string,
	context: { lessonId: string; officeHoursWorkshopId?: string },
) {
	const { content } = await compileMDX(source, {}, {}, context)
	const stream = await renderToReadableStream(content)
	return new Response(stream).text()
}

describe('office-hours MDX authorization and cache order', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.getCohortOfficeHoursSessionsForWorkshop.mockResolvedValue([session])
	})

	it('does not resolve authored inline sessions through the protected cohort lookup', async () => {
		const source = `<OfficeHoursSchedule
			timeZone="UTC"
			sessions={[${JSON.stringify(session)}]}
		/>`

		await renderOfficeHoursMdx(source, {
			lessonId: 'inline-session-lesson',
		})

		expect(
			mocks.getCohortOfficeHoursSessionsForWorkshop,
		).not.toHaveBeenCalled()
	})

	it('fails closed when the protected cohort resolver rejects', async () => {
		mocks.getCohortOfficeHoursSessionsForWorkshop.mockRejectedValue(
			new Error('database unavailable'),
		)

		const markup = await renderOfficeHoursMdx(
			'<OfficeHoursSchedule cohortId="resolver-failure" timeZone="UTC" />',
			{
				lessonId: 'resolver-failure-lesson',
				officeHoursWorkshopId: 'workshop-1',
			},
		)

		expect(markup).not.toContain('Watch Replay')
		expect(mocks.error).toHaveBeenCalledWith(
			'mdx.office-hours-schedule.cohort-load-failed',
			expect.objectContaining({
				cohortId: 'resolver-failure',
				workshopId: 'workshop-1',
				error: 'database unavailable',
			}),
		)
	})

	it('skips a cohort lookup when protected workshop context is absent', async () => {
		const markup = await renderOfficeHoursMdx(
			'<OfficeHoursSchedule cohortId="missing-context" timeZone="UTC" />',
			{ lessonId: 'missing-context-lesson' },
		)

		expect(markup).not.toContain('Watch Replay')
		expect(
			mocks.getCohortOfficeHoursSessionsForWorkshop,
		).not.toHaveBeenCalled()
	})

	it('keeps anonymous output empty when anonymous compilation happens first', async () => {
		const source =
			'<OfficeHoursSchedule cohortId="anonymous-first" timeZone="UTC" />'

		const anonymousMarkup = await renderOfficeHoursMdx(source, {
			lessonId: 'same-lesson-anonymous-first',
		})
		expect(anonymousMarkup).not.toContain('Watch Replay')
		expect(
			mocks.getCohortOfficeHoursSessionsForWorkshop,
		).not.toHaveBeenCalled()

		await renderOfficeHoursMdx(source, {
			lessonId: 'same-lesson-anonymous-first',
			officeHoursWorkshopId: 'workshop-1',
		})
		expect(mocks.getCohortOfficeHoursSessionsForWorkshop).toHaveBeenCalledWith({
			cohortId: 'anonymous-first',
			workshopId: 'workshop-1',
		})
	})

	it('keeps anonymous output empty when purchaser compilation happens first', async () => {
		const source =
			'<OfficeHoursSchedule cohortId="purchaser-first" timeZone="UTC" />'

		await renderOfficeHoursMdx(source, {
			lessonId: 'same-lesson-purchaser-first',
			officeHoursWorkshopId: 'workshop-1',
		})
		expect(mocks.getCohortOfficeHoursSessionsForWorkshop).toHaveBeenCalledWith({
			cohortId: 'purchaser-first',
			workshopId: 'workshop-1',
		})

		mocks.getCohortOfficeHoursSessionsForWorkshop.mockClear()

		const anonymousMarkup = await renderOfficeHoursMdx(source, {
			lessonId: 'same-lesson-purchaser-first',
		})
		expect(anonymousMarkup).not.toContain('Watch Replay')
		expect(
			mocks.getCohortOfficeHoursSessionsForWorkshop,
		).not.toHaveBeenCalled()
	})
})
