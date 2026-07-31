import * as React from 'react'
import Link from 'next/link'
import { ArrowRight } from 'lucide-react'

import { BADGE_OUTLINE, TYPE } from './type'

import { cn } from '@coursebuilder/utils/cn'

/**
 * The `Resource` variant for `ActivityRung` (`variant="ladder"`): a catalogue
 * entry — format label, title, arrow — with no artwork.
 *
 * Distinct from `list` (the dense `TopicsGrid` variant): the arrow is
 * persistent rather than revealed on hover, because as bare text at body
 * weight these rows read as prose and get skipped, and a rung whose whole job
 * is to offer somewhere to go cannot afford that.
 *
 * The divider lives on the anchor, not on a wrapping `<li>`. The anchor pulls
 * its hover fill wider than the text column (`-mx-4`), so a border drawn on
 * the wrapper stopped short of the fill and the two edges disagreed by 4 on
 * each side. Same element, same box, no drift.
 *
 * The meta line is the format, not the reading time. Duration resolves for
 * only a fraction of posts, so it appeared on roughly one row per rung and
 * read as a rendering fault; article-vs-video is known for every resource and
 * is the distinction a reader is actually choosing between here.
 */
export function ResourceLadderItem({
	title,
	href,
	isVideo,
}: {
	title: string
	href: string
	isVideo?: boolean
}) {
	return (
		<Link
			href={href}
			className="group border-border hover:bg-muted/60 focus-visible:ring-ring flex items-center gap-4 border-b py-3 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset md:-mx-4 md:px-4"
		>
			{/* The label sits in its own fixed column to the LEFT of the title,
			    not stacked above it. Stacked, three rows of two lines each read
			    as six items; in a column the labels line up and the titles start
			    on one left edge, so the rung scans as a list of three things with
			    a format each. */}
			<span className="hidden w-[74px] flex-none sm:block">
				<span className={cn(TYPE.badge, BADGE_OUTLINE, 'inline-flex w-fit')}>
					{isVideo ? 'Video' : 'Article'}
				</span>
			</span>
			<span className="flex min-w-0 flex-1 flex-col items-start gap-1.5">
				<span
					className={cn(TYPE.badge, BADGE_OUTLINE, 'inline-flex w-fit sm:hidden')}
				>
					{isVideo ? 'Video' : 'Article'}
				</span>
				<span className={cn(TYPE.bodyTight, 'text-balance')}>
					{title}
				</span>
			</span>
			<ArrowRight
				aria-hidden
				className="text-muted-foreground group-hover:text-foreground ease-out-quart size-4 shrink-0 transition-all duration-300 group-hover:translate-x-1 motion-reduce:transform-none motion-reduce:transition-none"
			/>
		</Link>
	)
}
