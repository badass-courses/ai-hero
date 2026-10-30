'use client'

import type * as React from 'react'
import { ZoomIn } from 'lucide-react'

import { Button, Dialog, DialogContent, DialogTrigger } from '@coursebuilder/ui'
import { cn } from '@coursebuilder/ui/utils/cn'

/**
 * The markdown-table treatment, shared by the inline table and the zoom dialog
 * so the two cannot drift.
 *
 * `not-prose` on the wrapper turns OFF every Tailwind Typography table rule,
 * which is why this string has to say everything — including the things a
 * reader reads as "a table": a rule under the header, and a header that is
 * not just the same 14px text one weight heavier.
 *
 * Two departures from what was here before, both from the redesign spec's
 * `.ah-table` (`aihero.css`):
 *
 * - **`w-full`, not `w-auto` + `min-w-max`.** Sizing to content left a two
 *   column table hugging the left half of the measure with a ragged gutter
 *   beside it, which is what read as "weird". Wide tables still scroll: the
 *   `min-w-[36rem]` floor is what the parent's `overflow-x-auto` acts on.
 * - **The head row gets a rule, not a fill.** The spec's `.ah-table` tints
 *   the head row, but the table now carries its own outline and radius (see
 *   `TableWrapper`) and a second surface inside that frame is one treatment
 *   too many — the `border-border` rule and the weight already say "header".
 *   Row separators drop to `--ah-line-soft` (DESIGN.md rule 2: dividers
 *   *inside* an object are the soft step, not the object's own edge).
 *
 * Cell padding and size are the spec's 14px/16px and 14.5px/1.45. Markdown
 * column alignment (`:---:`) survives: it lands as an inline `style`, which
 * beats `[&_th]:text-left`.
 */
const TABLE_CELL_CLASSES =
	'min-w-0 [&_table]:w-full [&_table]:min-w-[36rem] [&_table]:border-separate [&_table]:border-spacing-0 ' +
	'[&_th]:border-border [&_th]:border-b [&_th]:px-4 [&_th]:py-3 [&_th]:text-left [&_th]:align-bottom [&_th]:text-sm [&_th]:font-semibold ' +
	'[&_td]:border-[color:var(--ah-line-soft)] [&_td]:px-4 [&_td]:py-3.5 [&_td]:align-top [&_td]:text-sm [&_td]:leading-[1.45] ' +
	'[&_tr:not(:last-child)_td]:border-b ' +
	'[&_code]:text-[0.85em] [&_td_code]:whitespace-normal [&_td_code]:break-words [&_th_code]:whitespace-normal [&_th_code]:break-words'

export const TableWrapper = ({
	children,
	className,
}: {
	children: React.ReactNode
	/** Outer spacing, for a host other than article prose. */
	className?: string
}) => {
	return (
		<div
			className={cn(
				'not-prose relative -mx-4 mb-8 px-4 md:mx-0 md:px-0',
				className,
			)}
		>
			{/* The table is an object sitting ON the page, so it takes the panel
			    radius and a card outline (DESIGN.md rule 12 / rule 2) rather than
			    bleeding into the prose. `not-prose` also killed the margin
			    Typography puts under a table, which is why the paragraph after one
			    was landing 15px below it while the paragraph above sat 36px clear;
			    `mb-8` on the wrapper puts that rhythm back.

			    `overflow-hidden` here, `overflow-x-auto` on the child: the radius
			    has to clip a table that is wider than the frame, and a single
			    element cannot both scroll horizontally and clip its own corners
			    cleanly. It also keeps the scroll fade inside the border rather
			    than painted over it. */}
			<div className="bg-background border-input relative overflow-hidden rounded-lg border">
				{/* The right-edge fade is gone rather than re-padded around. It was
				    rendered unconditionally, so on the common case — a table that
				    fits — it washed out the last 40px of the rightmost column for no
				    reason, and the `pr-10` that used to hide that cost the table its
				    alignment with the prose measure. Both symptoms were the same
				    thing: a permanent overlay standing in for a conditional signal.

				    Nothing replaces it. The frame's border now bounds the table, so
				    a row that continues past it is visibly cut rather than faded
				    into the page, and the zoom dialog is the way out for a table
				    that genuinely does not fit. If we want the affordance back it
				    should be the self-hiding `background-attachment: local` scroll
				    shadow, which paints behind the cells instead of over them. */}
				<div className="relative z-0 w-full overflow-x-auto">
					<div className={TABLE_CELL_CLASSES}>{children}</div>
				</div>
				{/* Inside the frame, in the header band. It used to hang off the
				    wrapper at `-top-5 right-0`, which straddled the corner — fine
				    when the table had no outline to straddle, wrong now that it
				    does. Sized to sit within the header row's 44px, and given its
				    own translucent fill so the column heading it may overlap on a
				    dense table still reads underneath. */}
				<Dialog>
					<DialogTrigger asChild>
						<Button
							size="icon"
							variant="outline"
							className="bg-background/80 absolute top-2 right-2 z-20 size-8 backdrop-blur-sm"
						>
							<ZoomIn />
							<span className="sr-only">View Table</span>
						</Button>
					</DialogTrigger>
					<DialogContent className="max-w-none sm:max-w-[90%]">
						<div className="relative w-full overflow-x-auto pb-5">
							{/* Same treatment, one step up in body size — the dialog exists
							    to make a cramped table readable. The four hardcoded
							    `[&_thead_th:nth-child(n)]:w-[…]` column widths that used to
							    live here were sized for one specific four-column table and
							    silently mangled the shape of every other one. */}
							<div className={cn(TABLE_CELL_CLASSES, '[&_td]:text-base')}>
								{children}
							</div>
						</div>
					</DialogContent>
				</Dialog>
			</div>
		</div>
	)
}
