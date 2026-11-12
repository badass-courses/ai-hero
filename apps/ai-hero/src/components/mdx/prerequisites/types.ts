import type * as React from 'react'

/** One prerequisite lesson, resolved on the server from the authored link. */
export type PrerequisiteItem = {
	/** Content resource id of the linked lesson; progress is keyed on it. */
	lessonId: string
	title: string
	href: string
	/** Mux thumbnail of the lesson video, 16:9. Null when it has no video. */
	thumbnailUrl: string | null
	durationSeconds: number | null
	/** Matt's "why it matters" line. Can hold inline code. */
	reason: React.ReactNode
}

/**
 * What the view renders. All state lives in the container, so the view is
 * pure.
 */
export type PrerequisitesViewProps = {
	/** The authored heading, e.g. "Crash Course Prerequisites". */
	title: string
	/** Depth of the authored heading; the title renders at this level. */
	level: 1 | 2 | 3 | 4 | 5 | 6
	items: Array<PrerequisiteItem & { completed: boolean }>
	completedCount: number
	allCompleted: boolean
	/**
	 * False until the learner's progress has loaded (and for signed-out
	 * visitors, forever). Render rows without a completion claim either way.
	 */
	progressKnown: boolean
	/**
	 * One-line state. True when every prerequisite is completed, or when the
	 * learner hid the block on this lesson. The learner can always expand it.
	 */
	collapsed: boolean
	onCollapsedChange: (collapsed: boolean) => void
}
