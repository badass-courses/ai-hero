import type { ModuleProgress } from '@coursebuilder/core/schemas'

export type RequiredModuleProgress = ModuleProgress & {
	optionalLessonIds?: string[]
}

export type ModuleLesson = {
	id: string
	type: string
	slug: string | null
	optional: boolean
}

/** Retain optional completion records so their own checkboxes still work. */
export function countRequiredModuleProgress(
	progress: ModuleProgress,
	lessons: ModuleLesson[],
): RequiredModuleProgress {
	const optionalLessonIds = lessons
		.filter((lesson) => lesson.optional)
		.map((lesson) => lesson.id)
	// Preserve the existing result exactly for modules without optional lessons.
	if (optionalLessonIds.length === 0) return progress
	const required = lessons.filter((lesson) => !lesson.optional)
	const completedIds = new Set(
		progress.completedLessons
			.filter((item) => item.completedAt)
			.map((item) => item.resourceId),
	)
	const completedLessonsCount = required.filter((lesson) =>
		completedIds.has(lesson.id),
	).length
	const next = required.find((lesson) => !completedIds.has(lesson.id))
	return {
		...progress,
		optionalLessonIds,
		completedLessonsCount,
		totalLessonsCount: required.length,
		percentCompleted: required.length
			? Math.ceil((completedLessonsCount / required.length) * 100)
			: 100,
		nextResource: next
			? { id: next.id, type: next.type, fields: { slug: next.slug } }
			: null,
	}
}
