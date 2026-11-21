import { createMongoAbility } from '@casl/ability'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	getLesson: vi.fn(),
	forLesson: vi.fn(),
	allForLesson: vi.fn(),
	getSolution: vi.fn(),
	parentLesson: vi.fn(),
}))
vi.mock('@/lib/lessons/lessons.service', () => ({ getLesson: mocks.getLesson }))
vi.mock('@/lib/solutions-query', () => ({
	createSolution: vi.fn(),
	deleteSolution: vi.fn(),
	getAllSolutionsForLesson: mocks.allForLesson,
	getLessonForSolution: mocks.parentLesson,
	getSolution: mocks.getSolution,
	getSolutionForLesson: mocks.forLesson,
}))
vi.mock('@/server/auth', () => ({ getServerAuthSession: vi.fn() }))
vi.mock('@/server/logger', () => ({
	log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
	serializeError: (e: unknown) => String(e),
}))

import { solutionsRouter } from './solutions'

const lesson = { id: 'lesson-paid', type: 'lesson', createdById: 'author' }
const published = {
	id: 'solution-1',
	type: 'solution',
	createdById: 'author',
	fields: { state: 'published', title: 'S1' },
}
const draft = {
	id: 'solution-2',
	type: 'solution',
	createdById: 'author',
	fields: { state: 'draft', title: 'S2' },
}

function caller(rules: Parameters<typeof createMongoAbility>[0]) {
	return solutionsRouter.createCaller({
		session: { user: { id: 'u1' } },
		ability: createMongoAbility(rules),
		headers: new Headers(),
		db: {},
	} as any)
}
// Signed in, but no entitlement to the paid lesson.
const learner = () => caller([])
// Entitled to read the lesson, not an editor.
const entitled = () =>
	caller([
		{ action: 'read', subject: 'Content', conditions: { id: lesson.id } },
	])
const editor = () => caller([{ action: 'manage', subject: 'all' }])

beforeEach(() => {
	vi.clearAllMocks()
	mocks.getLesson.mockResolvedValue(lesson)
	mocks.parentLesson.mockResolvedValue(lesson)
	mocks.forLesson.mockResolvedValue(published)
	mocks.allForLesson.mockResolvedValue([published, draft])
	mocks.getSolution.mockResolvedValue(draft)
})

describe('solutions router reads', () => {
	it('refuses a signed-in learner without access to the lesson', async () => {
		const c = learner()
		for (const run of [
			() => c.getForLesson({ lessonId: lesson.id }),
			() => c.getAllForLesson({ lessonId: lesson.id }),
			() => c.getSolution({ solutionSlugOrId: published.id }),
			() => c.getParentLesson({ solutionId: published.id }),
		]) {
			await expect(run()).rejects.toMatchObject({ code: 'FORBIDDEN' })
		}
		expect(mocks.forLesson).not.toHaveBeenCalled()
		expect(mocks.allForLesson).not.toHaveBeenCalled()
	})

	it('shows an entitled learner published solutions only', async () => {
		const c = entitled()
		expect(await c.getForLesson({ lessonId: lesson.id })).toEqual(published)
		expect(await c.getAllForLesson({ lessonId: lesson.id })).toEqual([
			published,
		])
		expect(await c.getSolution({ solutionSlugOrId: draft.id })).toBeNull()
	})

	it('shows an editor drafts', async () => {
		const c = editor()
		expect(await c.getAllForLesson({ lessonId: lesson.id })).toEqual([
			published,
			draft,
		])
		expect(await c.getSolution({ solutionSlugOrId: draft.id })).toEqual(draft)
	})
})
