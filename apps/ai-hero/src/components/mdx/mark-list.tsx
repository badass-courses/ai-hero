import * as React from 'react'

export type MarkListProps = {
	/**
	 * What the list is saying about its items: `positive` draws a green check,
	 * `negative` a red cross.
	 */
	tone?: 'positive' | 'negative'
	children: React.ReactNode
}

/**
 * A markdown list with a check or a cross where the dot would be.
 *
 * It wraps the list rather than taking `items`, unlike `Contrast` and
 * `Comparison`: those restructure when they stack and need to know which
 * heading owns which item, while this only swaps a marker. So the author keeps
 * writing an ordinary list, bold lead-ins and links included:
 *
 *     <MarkList tone="negative">
 *
 *     - **Bug Catcher.** Your role shrinks to code review.
 *
 *     </MarkList>
 *
 * The verdict is in the glyph's shape as well as its colour, so a reader who
 * cannot tell the red from the green still gets a cross and a check. All of
 * the styling is `.ah-marks` in `globals.css`, beside the `.ah-bullets` rules
 * it modifies.
 */
export function MarkList({ tone = 'positive', children }: MarkListProps) {
	return (
		<div className="ah-marks" data-tone={tone}>
			{children}
		</div>
	)
}
