import * as React from 'react'
import Link from 'next/link'
import { ArrowRight } from 'lucide-react'

/**
 * The `Resource` variant for `ActivityRung` (`variant="ladder"`): a catalogue
 * entry — format label, title, arrow — with no artwork.
 *
 * Distinct from `list` (the dense `TopicsGrid` variant) in two ways that
 * matter at this size. The arrow is persistent rather than revealed on hover,
 * and the title carries a hover underline: as bare text at body weight these
 * rows read as prose and get skipped, and a rung whose whole job is to offer
 * somewhere to go cannot afford that.
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
			className="group hover:bg-muted/60 focus-visible:ring-ring flex items-center gap-4 py-3.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset md:-mx-4 md:px-4"
		>
			<span className="flex min-w-0 flex-1 flex-col gap-1">
				<span className="text-muted-foreground font-mono text-[11px] font-medium uppercase tracking-wider">
					{isVideo ? 'Video' : 'Article'}
				</span>
				<span className="text-balance text-base font-medium leading-snug decoration-current/30 underline-offset-4 group-hover:underline">
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
