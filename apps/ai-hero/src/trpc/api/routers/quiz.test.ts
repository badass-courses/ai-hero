import { describe, expect, it, vi } from 'vitest'

vi.mock('@/server/auth', () => ({ getServerAuthSession: vi.fn() }))

import { quizRouter } from './quiz'

describe('quiz.answer authorization', () => {
	it('rejects an unauthenticated caller before persistence', async () => {
		const caller = quizRouter.createCaller({
			db: null,
			session: null,
			ability: null,
			headers: new Headers(),
		} as any)

		await expect(
			caller.answer({
				lessonId: 'lesson-1',
				questionId: 'question-1',
				answer: 'a',
			}),
		).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
	})
})
