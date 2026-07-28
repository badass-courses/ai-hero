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
				<span className="text-muted-foreground font-mono text-[11px] font-medium uppercase tracking-wider">
					{meta}
				</span>
			) : null}
		</Link>
	)
}

/**
 * One line of context under the title. A lesson count beats a type label when
 * we have one: "6 lessons" tells the reader what they are committing to.
 */
function listMeta(type?: string, lessonCount?: number): string | null {
	if (lessonCount && lessonCount > 0) {
		return `${lessonCount} ${lessonCount === 1 ? 'lesson' : 'lessons'}`
	}
	if (!type) return null
	switch (type) {
		case 'post':
			return 'Article'
		case 'list':
			return 'Series'
		case 'workshop':
			return 'Workshop'
		case 'cohort':
			return 'Cohort'
		case 'event':
			return 'Event'
		default:
			return type.charAt(0).toUpperCase() + type.slice(1)
	}
}
