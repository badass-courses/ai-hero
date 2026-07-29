import * as React from 'react'
import { TYPE } from '@/components/landing/type'

import { cn } from '@coursebuilder/ui/utils/cn'

/** One attribute being compared: the row label plus a value per side. */
export type ComparisonRow = {
	/** The attribute name — the 112px key column on desktop, the block header
	 * on mobile. */
	key: string
	left: string
	right: string
}

export type ComparisonProps = {
	/** Left column heading, e.g. "ML Engineers". */
	left: string
	/** Right column heading, e.g. "AI Engineers". */
	right: string
	rows: ComparisonRow[]
	/** Which side the reader is being pointed at. Its label goes accent so the
	 * comparison keeps a direction once the table stacks and the two sides stop
	 * sitting next to each other. */
	highlight?: 'left' | 'right'
	className?: string
}

/**
 * The spec's `.ah-table` comparison (`aihero.css`), e.g. ML vs AI Engineers.
 *
 * It takes structured props rather than markdown, and that is the entire reason
 * it exists. Below 900px a three-column table has nowhere to go: it either
 * scrolls sideways (banned by the mobile spec — see `Mobile Patterns` § 3c) or
 * it crushes both value columns to a word each. So each row becomes its own
 * bordered block with the attribute as the header and both sides labelled. A
 * markdown table cannot restructure itself like that, which is why authors get
 * a component instead of a `|---|---|`.
 *
 * The layout is one DOM tree, not a desktop copy plus a mobile copy: the row
 * container flips between a `112px 1fr 1fr` grid and a stacked block, and the
 * per-cell side labels are simply hidden once the column headers are visible.
 * Duplicating the markup would double every string for screen readers and let
 * the two copies drift.
 */
export function Comparison({
	left,
	right,
	rows,
	highlight,
	className,
}: ComparisonProps) {
	return (
		<div
			className={cn(
				'not-prose my-6 flex flex-col gap-2.5',
				// Above the breakpoint the blocks lose their own borders and fuse
				// back into one bordered table.
				'min-[900px]:border-border min-[900px]:block min-[900px]:gap-0 min-[900px]:overflow-hidden min-[900px]:rounded-md min-[900px]:border',
				className,
			)}
		>
			{/* Column headers only make sense once the sides are side by side; when
			    stacked, each cell carries its own label instead. */}
			<div className="border-border bg-card hidden border-b min-[900px]:grid min-[900px]:grid-cols-[112px_minmax(0,1fr)_minmax(0,1fr)]">
				<div className="px-4 py-3.5" />
				<div
					className={cn(
						TYPE.micro,
						'px-4 py-3.5',
						highlight === 'left'
							? 'text-primary'
							: 'text-[color:var(--ah-fg-label)]',
					)}
				>
					{left}
				</div>
				<div
					className={cn(
						TYPE.micro,
						'px-4 py-3.5',
						highlight === 'right'
							? 'text-primary'
							: 'text-[color:var(--ah-fg-label)]',
					)}
				>
					{right}
				</div>
			</div>

			{rows.map((row) => (
				<div
					key={row.key}
					className={cn(
						'overflow-hidden rounded-md border border-input',
						'min-[900px]:grid min-[900px]:grid-cols-[112px_minmax(0,1fr)_minmax(0,1fr)] min-[900px]:rounded-none',
						'min-[900px]:border-x-0 min-[900px]:border-t-0 min-[900px]:border-b min-[900px]:border-[color:var(--ah-line-soft)] min-[900px]:last:border-b-0',
					)}
				>
					<div
						className={cn(
							TYPE.meta,
							'bg-card border-border border-b px-3.5 py-2.5',
							'min-[900px]:border-b-0 min-[900px]:bg-transparent min-[900px]:px-4 min-[900px]:py-3.5',
						)}
					>
						{row.key}
					</div>
					<Side
						label={left}
						value={row.left}
						highlighted={highlight === 'left'}
						className="border-b border-[color:var(--ah-line-soft)] min-[900px]:border-b-0"
					/>
					<Side
						label={right}
						value={row.right}
						highlighted={highlight === 'right'}
					/>
				</div>
			))}
		</div>
	)
}

/**
 * A single side of a row. The label is the stacked layout's only way of saying
 * which column a value came from, so it is rendered always and hidden by the
 * breakpoint rather than conditionally rendered.
 */
function Side({
	label,
	value,
	highlighted,
	className,
}: {
	label: string
	value: string
	highlighted: boolean
	className?: string
}) {
	return (
		<div className={cn('px-3.5 py-3 min-[900px]:px-4 min-[900px]:py-3.5', className)}>
			<div
				className={cn(
					TYPE.micro,
					'mb-1.5 min-[900px]:hidden',
					highlighted ? 'text-primary' : 'text-[color:var(--ah-fg-label)]',
				)}
			>
				{label}
			</div>
			<div
				className={cn(
					TYPE.metaProse,
					// The highlighted side sits at full ink; the side being contrasted
					// against it steps back so the eye lands on the answer first.
					highlighted
						? 'text-foreground'
						: 'text-[color:var(--ah-fg-muted)]',
				)}
			>
				{value}
			</div>
		</div>
	)
}
