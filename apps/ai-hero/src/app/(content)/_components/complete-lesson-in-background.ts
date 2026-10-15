import type { ModuleProgress } from '@coursebuilder/core/schemas'

/**
 * Marks a lesson complete the way the lesson progress toggle does: the durable
 * client store flips now, the server write runs in the background, and the
 * store reverts if the write fails. Never wrap this in a transition and never
 * revalidate after it: revalidatePath evicts the client prefetch cache.
 *
 * `setCompleted` is the tRPC `progress.setCompleted` mutation, never a server
 * action: Next's router queues server actions with navigations, and one that
 * settles during the push after it replays the old page over the new one.
 */
export function completeLessonInBackground({
	resourceId,
	moduleProgress,
	addLessonProgress,
	removeLessonProgress,
	setCompleted,
}: {
	resourceId: string
	moduleProgress: ModuleProgress | null
	addLessonProgress: (lessonId: string) => void
	removeLessonProgress: (lessonId: string) => void
	setCompleted: (input: {
		resourceId: string
		isCompleted: boolean
	}) => Promise<unknown>
}): Promise<void> {
	const isCompleted = Boolean(
		moduleProgress?.completedLessons?.some(
			(p) => p.resourceId === resourceId && p.completedAt,
		),
	)
	if (isCompleted) return Promise.resolve()

	addLessonProgress(resourceId)
	return setCompleted({ resourceId, isCompleted: true }).then(
		// null means the write failed (or there is nobody to record it for).
		(result) => {
			if (result == null) removeLessonProgress(resourceId)
		},
		() => removeLessonProgress(resourceId),
	)
}
