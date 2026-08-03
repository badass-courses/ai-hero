'use client'

import * as React from 'react'
import Link from 'next/link'
import { useProgress } from '@/app/(content)/[post]/_components/progress-provider'
import { setProgressForResource } from '@/lib/progress'

/**
 * A `next/link` that records the reader is DONE with the current resource as
 * they leave through it.
 *
 * A page's closing navigation — the skill pager's "Next skill", the related
 * reading rows a list finale ends on — is its "done here" gesture, the same
 * way Continue is on the lesson pager. Those surfaces replace the lesson
 * pager rather than sit under it, so without carrying the write themselves
 * they leave the current resource permanently unticked in the sidebar.
 *
 * Renders a plain link when `completesResourceId` is absent; outside a
 * `ProgressProvider` the optimistic tick degrades to a no-op (the default
 * context) while the server write still lands.
 */
export function CompleteOnNavigateLink({
	href,
	completesResourceId,
	className,
	children,
}: {
	href: string
	/** When set, navigating marks this resource (the CURRENT post) complete. */
	completesResourceId?: string
	className?: string
	children: React.ReactNode
}) {
	const { progress, addLessonProgress, removeLessonProgress } = useProgress()

	// Same shape as `PostUpNextPager`'s onContinue: optimistic tick first, the
	// link navigates without waiting on the write, and both failure modes roll
	// back — `setProgressForResource` resolves `null` when its own server-side
	// catch swallowed a DB failure, and rejects out here on transport failure.
	const markComplete = async () => {
		if (!completesResourceId) return
		const isCompleted = progress?.completedLessons.some(
			(lesson) => lesson.resourceId === completesResourceId,
		)
		if (isCompleted) return
		addLessonProgress(completesResourceId)
		try {
			const saved = await setProgressForResource({
				resourceId: completesResourceId,
				isCompleted: true,
			})
			if (!saved) removeLessonProgress(completesResourceId)
		} catch {
			removeLessonProgress(completesResourceId)
		}
	}

	return (
		<Link href={href} className={className} onClick={markComplete}>
			{children}
		</Link>
	)
}
