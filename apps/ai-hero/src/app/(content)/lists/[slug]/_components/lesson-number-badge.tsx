'use client'

import * as React from 'react'
import { useProgress } from '@/app/(content)/[post]/_components/progress-provider'
import { TYPE } from '@/components/landing/type'
import { Check } from 'lucide-react'

import { cn } from '@coursebuilder/utils/cn'

/**
 * The lesson's number in the series list — or a checkmark once it is finished,
 * the same swap `SeriesLessons` makes in the sidebar. A reader looking at the
 * rail and the list at the same time was told two different stories: the rail
 * showed five ticks, the list showed 01–05 as if none of it had happened.
 *
 * Client-only because progress is. `useProgress` defaults to `progress: null`
 * outside a `ProgressProvider`, so on any surface without one this degrades to
 * the plain number rather than throwing. Inside `[post]/layout.tsx` — which is
 * what renders a list page — the provider is seeded with server-fetched
 * progress, so the mark is right in the first paint and nothing swaps in.
 */
export function LessonNumberBadge({
	id,
	n,
	accent = false,
}: {
	/** The lesson resource id, matched against completed lessons. */
	id: string
	n: number
	/** The list accents its first row; that row's numeral is gold to match. */
	accent?: boolean
}) {
	const { progress } = useProgress()
	const isDone =
		progress?.completedLessons?.some((lesson) => lesson.resourceId === id) ??
		false

	return (
		<span
			className={cn(
				TYPE.command,
				isDone || accent
					? 'text-primary'
					: 'text-[color:var(--ah-fg-subtle)]',
			)}
		>
			{isDone ? (
				<>
					<Check className="size-3.5" strokeWidth={2.4} aria-hidden />
					<span className="sr-only">{`Lesson ${n}, completed`}</span>
				</>
			) : (
				String(n).padStart(2, '0')
			)}
		</span>
	)
}
