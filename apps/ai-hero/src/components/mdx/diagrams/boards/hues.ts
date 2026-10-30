import type * as React from 'react'

import { FLOW_ROLES } from '../roles'

/**
 * The colours Matt marks things with on his boards. Where a hue matches one of
 * the workflow cast it is that role's hue, so the course reads as one palette;
 * red and slate are the two his boards add.
 */
export const BOARD_HUES = {
	green: FLOW_ROLES.tracker.hue,
	amber: FLOW_ROLES.runner.hue,
	blue: FLOW_ROLES.orchestrator.hue,
	purple: FLOW_ROLES.human.hue,
	red: 'oklch(0.62 0.2 25)',
	slate: 'oklch(0.7 0.03 260)',
} as const

export type BoardHue = keyof typeof BOARD_HUES

/** A hue as custom properties: `--edge` for strokes and borders, `--ink` for
    text, `--wash` for a fill. Each is mixed with the theme so it holds its
    contrast in light and dark mode alike. */
export function hueStyle(hue: BoardHue) {
	return {
		'--hue': BOARD_HUES[hue],
		'--edge': 'color-mix(in oklab, var(--hue) 85%, var(--background))',
		'--ink': 'color-mix(in oklab, var(--hue) 72%, var(--foreground))',
		'--wash': 'color-mix(in oklab, var(--hue) 22%, var(--background))',
	} as React.CSSProperties
}

/** The ink every line on a board is drawn in, mixed to an opaque colour the
    way the cohort page's factory map mixes `--factory-ink`. Set as `color`,
    so strokes take it through `currentColor`. */
export const LINE_INK =
	'text-[color:color-mix(in_oklab,var(--foreground)_58%,var(--background))]'
