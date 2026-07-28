import * as React from 'react'
import Link from 'next/link'
import { ArrowRight } from 'lucide-react'

/**
 * A section's opening row: title and intro on the left, the section's "see
 * everything" link on the right.
 *
 * This replaces the pattern of a heading followed — a screenful later — by a
 * trailing link. Two problems with that: the reader only learns the section
 * has a destination after they have finished scanning it, and a trailing link
 * floating in its own padded strip reads as leftover rather than as part of
 * the section. Pairing them puts the promise and the exit in one glance.
 *
 * The link is a secondary (outline) pill, matching `/open-source`. Not a
 * filled one: the page has exactly one primary action — the newsletter — and
 * a second gold button a screenful away split the hierarchy.
 *
 * The left column is capped well short of the container so the heading breaks
 * at a readable measure instead of running the full width and leaving the link
 * stranded at the far edge.
 */
export function SectionHeader({
	heading,
	linkHref,
	linkLabel,
	children,
}: {
	heading?: string
	/** Omit for a section with no "see all" destination. */
	linkHref?: string
	linkLabel?: string
	/** Optional intro paragraph, set under the heading at reading measure. */
	children?: React.ReactNode
}) {
	return (
		<div className="flex flex-col gap-6 px-8 pb-10 pt-16 sm:px-16 md:flex-row md:items-start md:justify-between md:gap-12 md:pb-12">
			<div className="flex flex-col gap-4 md:max-w-2xl">
				{heading ? (
					<h2 className="text-balance text-3xl font-medium leading-tight tracking-tight sm:text-4xl">
						{heading}
					</h2>
				) : null}
				{children ? (
					<p className="max-w-[62ch] text-pretty text-base leading-relaxed opacity-80 sm:text-lg">
						{children}
					</p>
				) : null}
			</div>
			{linkHref ? (
				<Link
					href={linkHref}
					className="border-border text-foreground/80 hover:bg-muted hover:text-foreground focus-visible:ring-ring group inline-flex w-fit shrink-0 items-center gap-1.5 rounded-full border px-4 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 md:mt-1.5"
				>
					{linkLabel}
					<ArrowRight
						aria-hidden
						className="ease-out-quart size-3.5 shrink-0 transition-transform duration-300 group-hover:translate-x-1 motion-reduce:transform-none motion-reduce:transition-none"
					/>
				</Link>
			) : null}
		</div>
	)
}
