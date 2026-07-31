'use client'

import React from 'react'

import type { ModuleProgress } from '@coursebuilder/core/schemas'
import { moduleProgressSchema } from '@coursebuilder/core/schemas'

type ProgressContextType = {
	progress: ModuleProgress | null
	removeLessonProgress: (lessonId: string) => void
	addLessonProgress: (lessonId: string) => void
}

const ProgressContext = React.createContext<ProgressContextType>({
	progress: null,
	removeLessonProgress: () => {},
	addLessonProgress: () => {},
})

function progressReducer(
	progress: ModuleProgress | null,
	action:
		| { type: 'REMOVE_LESSON_PROGRESS'; payload: { lessonId: string } }
		| { type: 'ADD_LESSON_PROGRESS'; payload: { lessonId: string } },
) {
	const currentProgress =
		progress ||
		moduleProgressSchema.parse({
			completedLessons: [],
			nextResource: null,
			percentCompleted: 0,
			completedLessonsCount: 0,
			totalLessonsCount: 0,
		})

	const { lessonId } = action.payload
	let newProgress = currentProgress

	switch (action.type) {
		case 'ADD_LESSON_PROGRESS':
			newProgress = {
				...currentProgress,
				completedLessons: [
					...currentProgress.completedLessons,
					{ resourceId: lessonId, completedAt: new Date(), userId: '' },
				],
				completedLessonsCount: currentProgress.completedLessonsCount + 1,
			}
			break
		case 'REMOVE_LESSON_PROGRESS':
			newProgress = {
				...currentProgress,
				completedLessons: currentProgress.completedLessons.filter(
					(lesson) => lesson.resourceId !== lessonId,
				),
				completedLessonsCount: currentProgress.completedLessonsCount - 1,
			}
			break
	}

	return newProgress
}

/**
 * ProgressProvider manages the completion state of lessons within a module/list.
 * It handles both optimistic updates and server-synced progress state.
 *
 * Progress is seeded from the server-passed `initialProgress`. The former
 * `?list=` client-side override (fetching a different list's progress) was
 * removed 2026-07-06 — nothing links with `?list=`.
 *
 * Progress state includes:
 * - Completed lessons
 * - Progress statistics (percentCompleted, completedLessonsCount, etc.)
 * - Optimistic updates for immediate UI feedback
 *
 * @param initialProgress - The progress data fetched server-side during initial page load
 * @param children - React child components that will have access to progress context
 */
export function ProgressProvider({
	initialProgress,
	children,
}: {
	initialProgress: ModuleProgress | null
	children: React.ReactNode
}) {
	// Progress is the server-passed `initialProgress` for the current post's
	// list. The former `?list=` override (fetching a different list's progress
	// client side) was removed 2026-07-06 — nothing links with `?list=`.
	const [optimisticProgress, dispatch] = React.useReducer(
		progressReducer,
		initialProgress,
	)
	const updateOptimisticProgress = React.useCallback(
		(action: {
			type: 'REMOVE_LESSON_PROGRESS' | 'ADD_LESSON_PROGRESS'
			payload: { lessonId: string }
		}) => {
			dispatch(action)
		},
		[],
	)

	const removeLessonProgress = (lessonId: string) => {
		updateOptimisticProgress({
			type: 'REMOVE_LESSON_PROGRESS',
			payload: { lessonId },
		})
	}

	const addLessonProgress = (lessonId: string) => {
		updateOptimisticProgress({
			type: 'ADD_LESSON_PROGRESS',
			payload: { lessonId },
		})
	}

	return (
		<ProgressContext.Provider
			value={{
				progress: optimisticProgress,
				removeLessonProgress,
				addLessonProgress,
			}}
		>
			{children}
		</ProgressContext.Provider>
	)
}

export function useProgress() {
	return React.useContext(ProgressContext)
}
