/**
 * The line ink of the house drawings (`.ah-factory-map`'s `--factory-ink`):
 * an opaque mix of foreground into background, so rules and axes sit a step
 * under the labels in both themes.
 */
export const INK =
	'color-mix(in oklab, var(--foreground) 58%, var(--background))'

/**
 * Matt's marker colours. He colour-codes a step's dot or a ring by what it
 * is, and the same few hues recur across his charts, so they live here once.
 */
export const HUE = {
	blue: 'oklch(0.7 0.13 240)',
	orange: 'oklch(0.7 0.17 45)',
	yellow: 'oklch(0.8 0.15 80)',
	purple: 'oklch(0.64 0.2 315)',
	green: 'oklch(0.7 0.16 150)',
	red: 'oklch(0.63 0.21 25)',
	/** The AFK badge's rim: an indigo, bluer and deeper than `blue`. */
	indigo: 'oklch(0.6 0.19 270)',
} as const
