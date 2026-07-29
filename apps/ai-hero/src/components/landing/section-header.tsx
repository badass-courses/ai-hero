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
 * The link is an outline button, not a filled one: the page has exactly one
 * primary action — the newsletter — and a second filled button a screenful
 * away split the hierarchy.
 *
 * It carries no brand colour at all. An earlier version tinted its border and
 * arrow, which put a coloured control in three of the six sections and left the
 * page with four accents competing for "the thing to click". The prototype's
 * secondary control is a plain hairline outline (`border:1px solid
 * rgba(255,255,255,.2)`, 14px/500, 11×17, r9) and the gold is spent only on the
 * hero CTA and the cohort.
 *
 * The left column is capped well short of the container so the heading breaks
 * at a readable measure instead of running the full width and leaving the link
 * stranded at the far edge.
 */
/**
 * Which rank of section head this is. The prototype sizes its section heads by
 * how much of the page's argument each section carries (44 / 42 / 40 / 38 / 36
 * down the page), so the rank is the caller's decision, not the component's.
 *
 * `quiet` is the default because the only caller that reaches this component
 * straight from the CMS body is the trailing posts index, and that one is the
 * bottom of the ladder. `SkillsShowcase` and `ActivityLadder` ask for `lead`
 * in code, so the sizes come out right without the MDX having to carry a prop.
 */
export type SectionHeaderRank = 'lead' | 'quiet'

const RANK_TYPE: Record<SectionHeaderRank, string> = {
	lead: TYPE.section,
	quiet: TYPE.sectionQuiet,
}

export function SectionHeader({
	eyebrow,
	heading,
	rank = 'quiet',
	linkHref,
	linkLabel,
	children,
}: {
	/**
	 * Mono uppercase tag naming what the section is, above the heading. Every
	 * section head in the redesign carries one — it is what tells a reader
	 * scrolling past a wall of 34px headings which one they are looking at.
	 */
	eyebrow?: string
	heading?: string
	/** Size rank of the `h2`. See `SectionHeaderRank`. */
	rank?: SectionHeaderRank
	/** Omit for a section with no "see all" destination. */
	linkHref?: string
	linkLabel?: string
	/** Optional intro paragraph, set under the heading at reading measure. */
	children?: React.ReactNode
}) {
	return (
		<div // `.brand-corner` (globals.css) paints a blurred band wash into the
			// top-right corner. Parked for now — re-add the class to try it again.
			//
			// The link sits on the BOTTOM edge of the title block, not its top:
			// the last line of the intro and the button then share a baseline,
			// which is the only alignment available when the two columns are
			// wildly different heights.
			className={cn(
				'flex flex-col gap-6 px-[18px] pt-14 sm:px-11 md:flex-row md:items-end md:justify-between md:gap-[30px]',
				rank === 'quiet'
					? 'pb-9 sm:pt-[68px] md:pb-[30px]'
					: 'pb-10 sm:pt-[76px] md:pb-[38px]',
			)}>
			<div className="flex flex-col gap-4 md:max-w-2xl">
				{eyebrow ? (
					<p className={cn(TYPE.micro, 'text-[color:var(--ah-fg-label)]')}>
						{eyebrow}
					</p>
				) : null}
				{heading ? (
					<h2 className={cn(RANK_TYPE[rank], 'text-balance')}>{heading}</h2>
				) : null}
				{children ? (
					<p
						className={cn(
							TYPE.body,
							'max-w-[62ch] text-pretty text-[color:var(--ah-fg-muted)]',
						)}
					>
						{children}
					</p>
				) : null}
			</div>
			{linkHref ? (
				<Link
					href={linkHref}
					className={cn(
						TYPE.meta,
						'border-foreground/20 text-foreground hover:border-foreground/40 hover:bg-secondary focus-visible:ring-ring group inline-flex w-fit shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[9px] border px-[17px] py-[11px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2',
					)}
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
