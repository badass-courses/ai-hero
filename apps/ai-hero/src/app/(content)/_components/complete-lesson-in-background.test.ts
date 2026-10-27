import { beforeEach, describe, expect, it, vi } from 'vitest'

import { completeLessonInBackground } from './complete-lesson-in-background'

const progress = (completed: string[] = []) =>
	({
		completedLessons: completed.map((resourceId) => ({
			resourceId,
			completedAt: new Date(),
		})),
	}) as never

const mocks = { setProgress: vi.fn() }

describe('completeLessonInBackground', () => {
	const addLessonProgress = vi.fn()
	const removeLessonProgress = vi.fn()
	const run = (moduleProgress = progress(), optimistic = true) =>
		completeLessonInBackground({
			resourceId: 'lesson-1',
			moduleProgress,
			addLessonProgress,
			removeLessonProgress,
			setCompleted: mocks.setProgress,
			optimistic,
		})

	beforeEach(() => {
		vi.clearAllMocks()
	})

	it('flips the store before the write settles and keeps it on success', async () => {
		let settle!: (value: unknown) => void
		mocks.setProgress.mockReturnValue(new Promise((r) => (settle = r)))
		const done = run()
		expect(addLessonProgress).toHaveBeenCalledWith('lesson-1')
		expect(mocks.setProgress).toHaveBeenCalledWith({
			resourceId: 'lesson-1',
			isCompleted: true,
		})
		settle({ resourceId: 'lesson-1' })
		await done
		expect(removeLessonProgress).not.toHaveBeenCalled()
	})

	it.each([
		['returns null', () => Promise.resolve(null)],
		['throws', () => Promise.reject(new Error('offline'))],
	])('reverts the store when the write %s', async (_, write) => {
		mocks.setProgress.mockImplementation(write)
		await run()
		expect(removeLessonProgress).toHaveBeenCalledWith('lesson-1')
	})

	describe('without a session', () => {
		it('adds to the store once the write returns a record', async () => {
			let settle!: (value: unknown) => void
			mocks.setProgress.mockReturnValue(new Promise((r) => (settle = r)))
			const done = run(progress(), false)
			// A cookie-only subscriber: nothing until the server confirms.
			expect(addLessonProgress).not.toHaveBeenCalled()
			settle({ resourceId: 'lesson-1' })
			await done
			expect(addLessonProgress).toHaveBeenCalledWith('lesson-1')
			expect(removeLessonProgress).not.toHaveBeenCalled()
		})

		it.each([
			['returns null', () => Promise.resolve(null)],
			['throws', () => Promise.reject(new Error('offline'))],
		])('never touches the store when the write %s', async (_, write) => {
			mocks.setProgress.mockImplementation(write)
			await run(progress(), false)
			expect(addLessonProgress).not.toHaveBeenCalled()
			expect(removeLessonProgress).not.toHaveBeenCalled()
		})
	})

	it('does nothing for a lesson that is already complete', async () => {
		await run(progress(['lesson-1']))
		expect(addLessonProgress).not.toHaveBeenCalled()
		expect(mocks.setProgress).not.toHaveBeenCalled()
	})
})
