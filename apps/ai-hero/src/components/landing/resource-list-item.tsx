import * as React from 'react'
import Link from 'next/link'
import { ArrowRight } from 'lucide-react'

/**
 * The dense `Resource` variant (`variant="list"`), built for `TopicsGrid`:
 * title plus a one-line meta, no artwork. Three of these stack inside a
 * grid column, where the row and card variants would each demand an image
 * and a description.
 *
 * Hover follows the sidebar/list convention rather than the signature
 * gradient frame: at this size the frame's 5px inset reads as noise.
 */
export function ResourceListItem({
	title,
	href,
	type,
	lessonCount,
}: {
	title: string
	href: string
	type?: string
	lessonCount?: number
}) {
	const meta = listMeta(type, lessonCount)

	return (
		<Link
			href={href}
			className="group hover:bg-muted focus-visible:ring-ring flex flex-col gap-1 px-6 py-4 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset sm:px-8"
		>
			<span className="flex items-start gap-2">
				<span className="text-balance text-base font-medium leading-snug tracking-tight">
					{title}
				</span>
				<ArrowRight
					aria-hidden
					className="ease-out-quart text-muted-foreground mt-1 size-3.5 shrink-0 -translate-x-1 opacity-0 transition duration-300 group-hover:translate-x-0 group-hover:opacity-100 motion-reduce:transform-none motion-reduce:transition-none"
				/>
			</span>
			{meta ? (
				<span className="text-muted-foreground font-mono text-xs font-medium uppercase tracking-wider">
					{meta}
				</span>
			) : null}
		</Link>
	)
}

/**
 * One line of context under the title, or nothing.
 *
 * A count only appears for genuine multi-part resources. `resources.length` is
 * NOT a lesson count: an ordinary post carries its own videoResource there, so
 * counting it naively labelled every article "1 LESSON", which is both wrong
 * and noise. A single-item count tells the reader nothing either way, so the
 * floor is 2.
 *
 * Plain articles get no meta at all. In a dense three-per-column list the type
 * label was the same word repeated down the page, which is decoration, not
 * information.
 */
function listMeta(type?: string, lessonCount?: number): string | null {
	if (lessonCount && lessonCount > 1) return `${lessonCount} lessons`
	switch (type) {
		case 'list':
			return 'Series'
		case 'workshop':
			return 'Workshop'
		case 'cohort':
			return 'Cohort'
		case 'event':
			return 'Event'
		default:
			return null
	}
}
