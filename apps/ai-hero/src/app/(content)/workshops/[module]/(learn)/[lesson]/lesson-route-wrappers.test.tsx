import { isValidElement } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	LessonPage: vi.fn(() => null),
	getLesson: vi.fn(),
	getCachedExerciseSolution: vi.fn(),
	getCachedMinimalWorkshop: vi.fn(),
	notFound: vi.fn(() => {
		throw new Error('NEXT_HTTP_ERROR_FALLBACK;404')
	}),
}))

vi.mock('next/navigation', () => ({ notFound: mocks.notFound }))
vi.mock('./shared-page', () => ({ LessonPage: mocks.LessonPage }))
vi.mock('@/lib/lessons-query', () => ({
	getLesson: mocks.getLesson,
	getCachedExerciseSolution: mocks.getCachedExerciseSolution,
	getExerciseSolution: vi.fn(),
}))
vi.mock('@/lib/workshops-query', () => ({
	getCachedMinimalWorkshop: mocks.getCachedMinimalWorkshop,
}))
vi.mock('@/utils/get-og-image-url-for-resource', () => ({
	getOGImageUrlForResource: vi.fn(),
}))

import LessonExercisePage from './exercise/page'
import LessonSolutionPage from './solution/page'

const lesson = { id: 'lesson-1', type: 'lesson', fields: { body: 'PAID BODY' } }
const solution = {
	id: 'solution-1',
	type: 'solution',
	fields: { body: 'PAID SOLUTION' },
}

function props() {
	return {
		params: Promise.resolve({ module: 'the-workshop', lesson: 'lesson-1' }),
		searchParams: Promise.resolve({}),
	}
}

beforeEach(() => {
	vi.clearAllMocks()
	mocks.getLesson.mockResolvedValue(lesson)
	mocks.getCachedExerciseSolution.mockResolvedValue({ solution, lesson })
	mocks.getCachedMinimalWorkshop.mockResolvedValue({ id: 'workshop-1' })
})

// LessonPage runs the access check and redirects a viewer who may not open the
// lesson. Anything the route renders around it is serialized into the RSC
// stream first, so a wrapper holding the lesson ships it to every viewer.
describe('lesson route wrappers', () => {
	it('/exercise renders LessonPage itself, with nothing around it', async () => {
		const element = await LessonExercisePage(props())

		expect(isValidElement(element)).toBe(true)
		expect(element.type).toBe(mocks.LessonPage)
	})

	it('/solution renders LessonPage itself, with nothing around it', async () => {
		const element = await LessonSolutionPage(props())

		expect(isValidElement(element)).toBe(true)
		expect(element.type).toBe(mocks.LessonPage)
		expect(element.props).toMatchObject({ lesson: solution, problem: lesson })
	})

	it('/solution is a 404 for a lesson without a solution', async () => {
		mocks.getCachedExerciseSolution.mockResolvedValue(null)

		await expect(LessonSolutionPage(props())).rejects.toThrow(
			'NEXT_HTTP_ERROR_FALLBACK;404',
		)
		expect(mocks.notFound).toHaveBeenCalled()
	})
})
