/**
 * The inks of Matt's box-and-arrow drawings, set the way the cohort page's
 * factory map sets its lines: opaque mixes, so a line that runs under an
 * arrowhead or crosses another shows no brighter patch. Matt draws his
 * annotations in red and his seams in blue; both stay hues because the
 * colour is how a reader tells a label's pointer from the code's own arrows.
 */
export const GRAPH_INK = {
	line: 'color-mix(in oklab, var(--foreground) 58%, var(--background))',
	note: 'oklch(0.64 0.2 25)',
	seam: 'oklch(0.66 0.13 245)',
} as const
