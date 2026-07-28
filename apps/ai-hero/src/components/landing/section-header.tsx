import * as React from 'react'
import Link from 'next/link'
import { ArrowRight } from 'lucide-react'

import { TYPE } from './type'

import { cn } from '@coursebuilder/utils/cn'

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
 * The link is an outline pill, not a filled one: the page has exactly one
 * primary action — the newsletter — and a second filled button a screenful
 * away split the hierarchy.
 *
 * Brand colour sits on the BORDER and the ARROW, not the label. As small text
 * the light-mode vermilion has to be darkened toward brick before it clears
 * 4.5:1, and brick is not the brand colour any more. An icon only needs 3:1,
 * which the vermilion passes untouched — so the pill reads as brand-coloured
 * while its label stays full-contrast foreground.
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
		<div // `.brand-corner` (globals.css) paints a blurred band wash into the
			// top-right corner. Parked for now — re-add the class to try it again.
			className="flex flex-col gap-6 px-8 pb-10 pt-16 sm:px-16 md:flex-row md:items-start md:justify-between md:gap-12 md:pb-12">
			<div className="flex flex-col gap-4 md:max-w-2xl">
				{heading ? (
					<h2 className={cn(TYPE.heading, 'text-balance')}>
						{heading}
					</h2>
				) : null}
				{children ? (
					<p className={cn(TYPE.body, 'max-w-[62ch] text-pretty opacity-80')}>
						{children}
					</p>
				) : null}
			</div>
			{linkHref ? (
				<Link
					href={linkHref}
					className={cn(TYPE.meta, 'text-foreground hover:bg-primary/10 focus-visible:ring-ring group inline-flex w-fit shrink-0 items-center gap-1.5 rounded-full border border-[color-mix(in_oklch,var(--primary)_40%,transparent)] px-4 py-2 transition-colors hover:border-[color-mix(in_oklch,var(--primary)_70%,transparent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 md:mt-1.5')}
				>
					{linkLabel}
					<ArrowRight
						aria-hidden
						className="text-primary ease-out-quart size-3.5 shrink-0 transition-transform duration-300 group-hover:translate-x-1 motion-reduce:transform-none motion-reduce:transition-none"
					/>
				</Link>
			) : null}
		</div>
	)
}
