'use client'

import * as React from 'react'

import {
	ModuleProgress,
	moduleProgressSchema,
} from '@coursebuilder/core/schemas'

type ModuleProgressContextType = {
	moduleProgress: ModuleProgress | null
	removeLessonProgress: (lessonId: string) => void
	addLessonProgress: (lessonId: string) => void
}

const ModuleProgressContext = React.createContext<ModuleProgressContextType>({
	moduleProgress: null,
	removeLessonProgress: () => {},
	addLessonProgress: () => {},
})

type ProgressAction =
	| { type: 'REMOVE_LESSON_PROGRESS'; payload: { lessonId: string } }
	| { type: 'ADD_LESSON_PROGRESS'; payload: { lessonId: string } }

function progressReducer(
	progress: ModuleProgress | null,
	action: ProgressAction,
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

	const alreadyCompleted = currentProgress.completedLessons.some(
		(completedLesson) => completedLesson.resourceId === lessonId,
	)

	switch (action.type) {
		case 'ADD_LESSON_PROGRESS':
			// Idempotent: durable state means a repeated add must not double-count.
			if (alreadyCompleted) break
			newProgress = {
				...currentProgress,
				completedLessons: [
					...currentProgress.completedLessons,
					{
						resourceId: lessonId,
						completedAt: new Date(),
						userId: '',
					},
				],
				completedLessonsCount: currentProgress.completedLessonsCount + 1,
			}
			break
		case 'REMOVE_LESSON_PROGRESS':
			if (!alreadyCompleted) break
			newProgress = {
				...currentProgress,
				completedLessons: currentProgress.completedLessons.filter(
					(completedLesson) => completedLesson.resourceId !== lessonId,
				),
				completedLessonsCount: currentProgress.completedLessonsCount - 1,
			}
			break
	}

	// Keep percentCompleted in sync with the count. Durable state means stale
	// derived values stay visible (progress bar, `=== 100` certificate unlock)
	// instead of being masked by the old optimistic revert.
	if (newProgress !== currentProgress) {
		const total = newProgress.totalLessonsCount || 0
		newProgress = {
			...newProgress,
			// Math.ceil to match the server (adapter getModuleProgressForUser),
			// so the client-derived bar never disagrees with the canonical value.
			percentCompleted:
				total > 0
					? Math.ceil((newProgress.completedLessonsCount / total) * 100)
					: 0,
		}
	}

	return newProgress
}

export const ModuleProgressProvider = ({
	children,
	moduleProgressLoader,
}: {
	children: React.ReactNode
	moduleProgressLoader: Promise<ModuleProgress | null>
}) => {
	const initialProgress = React.use(moduleProgressLoader)

	// Durable state (not useOptimistic): the provider is mounted in the shared
	// [module] layout, so this survives lesson-to-lesson client navigations. A
	// toggled completion stays applied immediately everywhere instead of
	// reverting to the layout's once-loaded base while the server write catches
	// up — no router.refresh() needed.
	const [progress, dispatch] = React.useReducer(progressReducer, initialProgress)

	const removeLessonProgress = (lessonId: string) => {
		dispatch({
			type: 'REMOVE_LESSON_PROGRESS',
			payload: { lessonId },
		})
	}

	const addLessonProgress = (lessonId: string) => {
		dispatch({
			type: 'ADD_LESSON_PROGRESS',
			payload: { lessonId },
		})
	}

	const value = React.useMemo(
		() => ({
			moduleProgress: progress,
			removeLessonProgress,
			addLessonProgress,
		}),
		[progress],
	)
	return (
		<ModuleProgressContext.Provider value={value}>
			{children}
		</ModuleProgressContext.Provider>
	)
}

export const useModuleProgress = () => {
	const context = React.use(ModuleProgressContext)
	if (!context) {
		throw new Error(
			'useModuleProgress must be used within a ModuleProgressProvider',
		)
	}
	return context
}
