import { renderToReadableStream } from 'react-dom/server'
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
	log: {
		warn: mocks.warn,
		error: vi.fn(),
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

describe('office-hours MDX cache authorization order', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.getCohortOfficeHoursSessionsForWorkshop.mockResolvedValue([session])
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

		const purchaserMarkup = await renderOfficeHoursMdx(source, {
			lessonId: 'same-lesson-anonymous-first',
			officeHoursWorkshopId: 'workshop-1',
		})
		expect(purchaserMarkup).toContain('Watch Replay')
		expect(purchaserMarkup).toContain(
			'https://www.youtube.com/watch?v=recording-1',
		)
		expect(mocks.getCohortOfficeHoursSessionsForWorkshop).toHaveBeenCalledWith({
			cohortId: 'anonymous-first',
			workshopId: 'workshop-1',
		})
	})

	it('keeps anonymous output empty when purchaser compilation happens first', async () => {
		const source =
			'<OfficeHoursSchedule cohortId="purchaser-first" timeZone="UTC" />'

		const purchaserMarkup = await renderOfficeHoursMdx(source, {
			lessonId: 'same-lesson-purchaser-first',
			officeHoursWorkshopId: 'workshop-1',
		})
		expect(purchaserMarkup).toContain('Watch Replay')

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
