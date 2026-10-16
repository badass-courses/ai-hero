import type { ModuleProgress } from '@coursebuilder/core/schemas'

/**
 * Marks a lesson complete in the background. With a session the durable client
 * store flips now, like the lesson progress toggle, and reverts if the write
 * fails. Without one the viewer may still be an email-course subscriber, whom
 * the server knows by an httpOnly cookie the client cannot see, so the store
 * waits for the write and changes only if it recorded something: a subscriber
 * gets the check once it lands, an anonymous viewer never sees one flicker. Never wrap this in a transition and never
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
	optimistic,
}: {
	resourceId: string
	moduleProgress: ModuleProgress | null
	addLessonProgress: (lessonId: string) => void
	removeLessonProgress: (lessonId: string) => void
	setCompleted: (input: {
		resourceId: string
		isCompleted: boolean
	}) => Promise<unknown>
	/** True when the viewer has a session. */
	optimistic: boolean
}): Promise<void> {
	const isCompleted = Boolean(
		moduleProgress?.completedLessons?.some(
			(p) => p.resourceId === resourceId && p.completedAt,
		),
	)
	if (isCompleted) return Promise.resolve()

	if (!optimistic) {
		return setCompleted({ resourceId, isCompleted: true }).then(
			(result) => {
				if (result != null) addLessonProgress(resourceId)
			},
			() => {},
		)
	}

	addLessonProgress(resourceId)
	return setCompleted({ resourceId, isCompleted: true }).then(
		// null means the write failed.
		(result) => {
			if (result == null) removeLessonProgress(resourceId)
		},
		() => removeLessonProgress(resourceId),
	)
}
