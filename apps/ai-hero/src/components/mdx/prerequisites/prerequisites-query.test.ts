import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	getCachedLesson: vi.fn(),
	durationRows: vi.fn(),
}))

vi.mock('server-only', () => ({}))

vi.mock('@/lib/lessons-query', () => ({
	getCachedLesson: mocks.getCachedLesson,
}))

vi.mock('@/db', () => ({
	db: {
		select: () => ({
			from: () => ({ where: async () => mocks.durationRows() }),
		}),
	},
}))

import { getPrerequisiteLessons } from './prerequisites-query'

const lessonRow = (slug: string, fields: Record<string, unknown>) => ({
	id: `id-${slug}`,
	type: 'lesson',
	fields: { slug, title: `Title ${slug}`, ...fields },
	resources: [
		{ resourceId: `solution-${slug}`, resource: { type: 'solution' } },
		{ resourceId: `video-${slug}`, resource: { type: 'videoResource' } },
	],
})

describe('getPrerequisiteLessons', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.durationRows.mockReturnValue([{ id: 'video-a', duration: 231.6 }])
	})

	it('resolves a draft lesson, as the lesson route does', async () => {
		mocks.getCachedLesson.mockResolvedValue(
			lessonRow('a', { state: 'draft', visibility: 'unlisted' }),
		)

		const lessons = await getPrerequisiteLessons([
			{ module: 'crash', lesson: 'a' },
		])

		expect(mocks.getCachedLesson).toHaveBeenCalledWith('a')
		expect(lessons).toEqual([
			{
				lessonId: 'id-a',
				title: 'Title a',
				href: '/workshops/crash/a',
				thumbnailUrl: '/api/thumbnails?videoResourceId=video-a&width=720',
				durationSeconds: 232,
			},
		])
	})

	it('returns null when any linked lesson is missing', async () => {
		mocks.getCachedLesson.mockImplementation(async (slug: string) =>
			slug === 'a' ? lessonRow('a', { state: 'published' }) : null,
		)

		const lessons = await getPrerequisiteLessons([
			{ module: 'crash', lesson: 'a' },
			{ module: 'crash', lesson: 'gone' },
		])

		expect(lessons).toBeNull()
		expect(mocks.durationRows).not.toHaveBeenCalled()
	})

	it('accepts the types the lesson route serves: lesson, exercise, post', async () => {
		for (const type of ['lesson', 'exercise', 'post']) {
			mocks.getCachedLesson.mockResolvedValue({ ...lessonRow('a', {}), type })
			const lessons = await getPrerequisiteLessons([
				{ module: 'crash', lesson: 'a' },
			])
			expect(lessons?.[0]?.lessonId, type).toBe('id-a')
		}
	})

	it('rejects a slug that resolves to any other type (e.g. a solution)', async () => {
		for (const type of ['solution', 'workshop', 'videoResource', 'cohort']) {
			mocks.getCachedLesson.mockImplementation(async (slug: string) =>
				slug === 'a' ? lessonRow('a', {}) : { ...lessonRow('b', {}), type },
			)
			const lessons = await getPrerequisiteLessons([
				{ module: 'crash', lesson: 'a' },
				{ module: 'crash', lesson: 'b' },
			])
			expect(lessons, type).toBeNull()
		}
		expect(mocks.durationRows).not.toHaveBeenCalled()
	})

	it('has no thumbnail or duration for a lesson without a video', async () => {
		mocks.getCachedLesson.mockResolvedValue({
			...lessonRow('b', {}),
			resources: [],
		})

		const [lesson] =
			(await getPrerequisiteLessons([{ module: 'crash', lesson: 'b' }])) ?? []

		expect(lesson).toMatchObject({ thumbnailUrl: null, durationSeconds: null })
		expect(mocks.durationRows).not.toHaveBeenCalled()
	})
})
