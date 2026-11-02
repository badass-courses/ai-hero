/**
 * Colours for the email countdown GIF, keyed by their dark-theme token in
 * `src/styles/globals.css` (`.dark`). The route can't read the stylesheet at
 * runtime, so the values are copied here and `tokens.test.ts` fails when
 * they drift from the stylesheet.
 *
 * GIF frames are opaque and paletted, so every alpha token is flattened over
 * the card colour into a solid one.
 */
export const DARK_TOKENS = {
	'--card': '#100f0e',
	'--primary': '#f5c451',
	'--muted-foreground': 'rgba(244, 243, 241, 0.6)',
	'--border': 'rgba(255, 255, 255, 0.08)',
} as const

export type DarkToken = keyof typeof DARK_TOKENS

/**
 * Opacity of an unlit segment, as the accent over the card: the faint ghost a
 * real LED display shows. A design constant, not a token.
 */
export const GHOST_SEGMENT_ALPHA = 0.09

type Rgba = [number, number, number, number]
export type Rgb = [number, number, number]

export function parseColor(value: string): Rgba {
	const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(value)
	if (hex) {
		return [
			parseInt(hex[1]!, 16),
			parseInt(hex[2]!, 16),
			parseInt(hex[3]!, 16),
			1,
		]
	}
	const rgba =
		/^rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([\d.]+)\s*\)$/.exec(value)
	if (rgba) {
		return [Number(rgba[1]), Number(rgba[2]), Number(rgba[3]), Number(rgba[4])]
	}
	throw new Error(`Unsupported colour: ${value}`)
}

/** Composite `color` at `alpha` (times its own alpha) over an opaque colour. */
export function flatten(color: string, over: string, alpha = 1): Rgb {
	const [r, g, b, a] = parseColor(color)
	const [br, bg, bb] = parseColor(over)
	const t = a * alpha
	return [
		Math.round(br + (r - br) * t),
		Math.round(bg + (g - bg) * t),
		Math.round(bb + (b - bb) * t),
	]
}
