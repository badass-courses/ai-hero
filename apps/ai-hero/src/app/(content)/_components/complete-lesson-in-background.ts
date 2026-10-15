import { setProgressForResource } from '@/lib/progress'

import type { ModuleProgress } from '@coursebuilder/core/schemas'

/**
 * Marks a lesson complete the way the lesson progress toggle does: the durable
 * client store flips now, the server write runs in the background, and the
 * store reverts if the write fails. Never wrap this in a transition and never
 * revalidate after it: an async transition that awaits server actions gets
 * entangled with the router's navigation transition and hung the page on
 * "Continue", and revalidatePath evicts the client prefetch cache.
 *
 * Call it before `router.push`, not after. A server action dispatched while a
 * navigation is pending waits behind it in the router's action queue; one
 * dispatched first is sent at once, and the navigation overtakes it (its
 * router state is dropped, its result still resolves here).
 */
export function completeLessonInBackground({
	resourceId,
	moduleProgress,
	addLessonProgress,
	removeLessonProgress,
}: {
	resourceId: string
	moduleProgress: ModuleProgress | null
	addLessonProgress: (lessonId: string) => void
	removeLessonProgress: (lessonId: string) => void
}): Promise<void> {
	const isCompleted = Boolean(
		moduleProgress?.completedLessons?.some(
			(p) => p.resourceId === resourceId && p.completedAt,
		),
	)
	if (isCompleted) return Promise.resolve()

	addLessonProgress(resourceId)
	return setProgressForResource({ resourceId, isCompleted: true }).then(
		// null means the write failed (or there is nobody to record it for).
		(result) => {
			if (result == null) removeLessonProgress(resourceId)
		},
		() => removeLessonProgress(resourceId),
	)
}
