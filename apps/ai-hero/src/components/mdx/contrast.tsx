import * as React from 'react'
import { TYPE } from '@/components/landing/type'
import { Check, X } from 'lucide-react'

import { cn } from '@coursebuilder/ui/utils/cn'

export type ContrastProps = {
	/** Heading for the column being dismissed, e.g. "You don't need". */
	left: string
	/** Heading for the column that matters, e.g. "You do need". */
	right: string
	leftItems: string[]
	rightItems: string[]
	/**
	 * Draws a red cross on the left items and a green check on the right ones
	 * instead of the dots. For a before/after pair, where the left column is a
	 * state the reader wants out of rather than a thing they can skip.
	 */
	marks?: boolean
	className?: string
}

/**
 * The "you don't need / you do need" panel from the lesson page.
 *
 * The two sides are not peers, and the styling says so before the copy does:
 * the left column sits on the page surface with muted text and grey dots, the
 * right sits on a card with full ink and accent dots. A reader skimming the
 * panel should be able to tell which list is the answer without reading either
 * heading.
 *
 * Structured props rather than children for the same reason `Comparison` takes
 * them: when the columns stack, each list has to keep carrying its own heading,
 * and nested markdown lists give the component no way to know which heading
 * belongs to which items.
 *
 * Hairlines come from the grid (DESIGN rule 2): `gap-px` over `bg-border`, each
 * cell opaque, so the divider between the columns and the panel's own border
 * are the same 1px line rather than two stacked ones.
 */
export function Contrast({
	left,
	right,
	leftItems,
	rightItems,
	marks = false,
	className,
}: ContrastProps) {
	return (
		<div
			className={cn(
				'not-prose border-border bg-border my-6 grid gap-px overflow-hidden rounded-md border sm:grid-cols-2',
				className,
			)}
		>
			<Column
				heading={left}
				items={leftItems}
				className="bg-background"
				headingClassName="text-[color:var(--ah-fg-label)]"
				itemClassName="text-[color:var(--ah-fg-muted)]"
				dotClassName="bg-foreground/25"
				mark={marks ? 'no' : undefined}
			/>
			<Column
				heading={right}
				items={rightItems}
				className="bg-card"
				headingClassName="text-primary"
				itemClassName="text-foreground"
				// The gold fill, not `text-primary` — a dot is a fill, and in light
				// mode `--primary` is ink (DESIGN rule 7).
				dotClassName="bg-accent-fill/70"
				mark={marks ? 'yes' : undefined}
			/>
		</div>
	)
}

function Column({
	heading,
	items,
	className,
	headingClassName,
	itemClassName,
	dotClassName,
	mark,
}: {
	heading: string
	items: string[]
	className?: string
	headingClassName?: string
	itemClassName?: string
	dotClassName?: string
	mark?: 'yes' | 'no'
}) {
	const Glyph = mark === 'yes' ? Check : X
	return (
		<div className={cn('px-5 pb-6 pt-5 sm:px-[22px]', className)}>
			<div className={cn(TYPE.groupLabel, 'mb-4', headingClassName)}>{heading}</div>
			<ul className="flex flex-col gap-3">
				{items.map((item) => (
					<li
						key={item}
						className={cn(
							TYPE.metaProse,
							'flex',
							mark ? 'gap-2.5' : 'gap-3',
							itemClassName,
						)}
					>
						{mark ? (
							<Glyph
								aria-hidden
								// `mt-[3px]` centres a 16px glyph on the 22.75px line.
								className={cn(
									'mt-[3px] size-4 flex-none',
									mark === 'yes'
										? 'text-[color:var(--ah-mark-yes)]'
										: 'text-[color:var(--ah-mark-no)]',
								)}
								strokeWidth={2.4}
							/>
						) : (
							<span
								aria-hidden
								// `mt-2` puts the dot on the first line's optical centre; it
								// is a marker, not a bullet the flexbox should baseline.
								className={cn(
									'mt-2 size-[5px] flex-none rounded-full',
									dotClassName,
								)}
							/>
						)}
						{item}
					</li>
				))}
			</ul>
		</div>
	)
}
