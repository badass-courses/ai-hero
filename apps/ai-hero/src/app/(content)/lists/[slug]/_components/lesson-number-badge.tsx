'use client'

import * as React from 'react'
import { useProgress } from '@/app/(content)/[post]/_components/progress-provider'
import { TYPE } from '@/components/landing/type'
import { Check } from 'lucide-react'

import { cn } from '@coursebuilder/utils/cn'

/**
 * The lesson's number in the series list, plus a completion mark once it is
 * finished. A reader looking at the rail and the list at the same time was
 * told two different stories: the rail showed five ticks, the list showed
 * 01–05 as if none of it had happened.
 *
 * The number STAYS when complete — this differs from `SeriesLessons`, which
 * swaps the numeral out for the tick, and deliberately. That works in the rail
 * because the numeral lives in a fixed `w-5` column, so the tick inherits its
 * box and the rail stays a column. Here the badge is loose inline content in a
 * row whose heading is "N lessons, in order": swapping left a 14px glyph
 * floating on its own with nothing to align to, and finishing the series
 * erased the ordering the section is named after.
 *
 * So completion is a state ON the number rather than a replacement — a filled
 * gold disc, which is the one shape in the row that can carry a mark at this
 * size and still read as deliberate. Gold FILL with ink glyph, not gold type,
 * so it survives light mode (DESIGN rule 7).
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
		<span className={cn(TYPE.command, 'inline-flex items-center gap-[7px]')}>
			<span
				className={cn(
					'tabular-nums',
					// Done reads at full ink rather than the accent: the disc beside it
					// is already carrying the state, and two gold marks on one badge
					// makes the completed row shout louder than the current one.
					isDone
						? 'text-foreground'
						: accent
							? 'text-primary'
							: 'text-[color:var(--ah-fg-subtle)]',
				)}
			>
				{String(n).padStart(2, '0')}
			</span>
			{isDone && (
				<span
					aria-hidden
					className="bg-accent-fill text-accent-fill-foreground inline-flex size-[15px] shrink-0 items-center justify-center rounded-full"
				>
					<Check className="size-2.5" strokeWidth={3.25} />
				</span>
			)}
			{isDone && <span className="sr-only">completed</span>}
		</span>
	)
}
