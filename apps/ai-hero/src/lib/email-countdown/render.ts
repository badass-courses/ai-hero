import { GifWriter } from 'omggif'
import { GLYPH_COLUMNS, glyphRows } from './pixel-font'
import { frameSeconds, pad2, showsDays, splitSeconds } from './time'
import { DARK_TOKENS, flatten, GHOST_SEGMENT_ALPHA, type Rgb } from './tokens'

/**
 * Renders the email countdown as an animated GIF: a 7-segment LED display,
 * one frame per second for up to a minute, played once so the last frame
 * holds. Pure JS with no fonts or canvas, so it runs anywhere Node does.
 *
 * Drawn at 2x (1120 px wide); the email sets `width="560"`. The first frame
 * is the whole image. Each later frame is only the rectangle of digits that
 * changed, drawn over the previous one, which keeps the file small.
 */

export const WIDTH = 1120
export const HEIGHT = 300

// Palette indices. Eight colours, so pixels pack into 3-bit LZW codes.
const CARD = 0
const BORDER = 1
const GHOST = 2
const LIT_25 = 3
const LIT_50 = 4
const LIT_75 = 5
const LIT = 6
const LABEL = 7

function toInt([r, g, b]: Rgb): number {
	return (r << 16) | (g << 8) | b
}

const card = DARK_TOKENS['--card']
const primary = DARK_TOKENS['--primary']

export const PALETTE: readonly number[] = [
	flatten(card, card),
	flatten(DARK_TOKENS['--border'], card),
	flatten(primary, card, GHOST_SEGMENT_ALPHA),
	flatten(primary, card, 0.25),
	flatten(primary, card, 0.5),
	flatten(primary, card, 0.75),
	flatten(primary, card),
	flatten(DARK_TOKENS['--muted-foreground'], card),
].map(toInt)

// Geometry, in 2x pixels.
const BORDER_WIDTH = 2 // 1 CSS px
const DIGIT_WIDTH = 88
const DIGIT_HEIGHT = 160
const SEGMENT = 18 // stroke thickness
const SEGMENT_GAP = 3 // between segment tips
const SLANT = 0.07 // x shift per px of height, the italic of an LED display
const SLANT_PAD = Math.ceil(SLANT * DIGIT_HEIGHT)
const CELL_WIDTH = DIGIT_WIDTH + SLANT_PAD
// Wider than SLANT_PAD, so neighbouring digit cells never overlap and a
// changed digit can be blitted as a whole cell.
const DIGIT_SPACING = 18
const COLON_WIDTH = 64
const GROUP_WIDTH = DIGIT_WIDTH * 2 + DIGIT_SPACING
const DIGITS_TOP = 50
const LABEL_SCALE = 3
const LABEL_TRACKING = 2 // dots between letters
const LABEL_TOP = DIGITS_TOP + DIGIT_HEIGHT + 30

const SUPERSAMPLE = 4
const SAMPLES = SUPERSAMPLE * SUPERSAMPLE

type Point = readonly [number, number]
type Polygon = readonly Point[]

function slant(polygon: Polygon): Polygon {
	return polygon.map(([x, y]) => [x + SLANT * (DIGIT_HEIGHT - y), y] as const)
}

function horizontalSegment(y: number): Polygon {
	const h = SEGMENT / 2
	const x0 = h + SEGMENT_GAP
	const x1 = DIGIT_WIDTH - h - SEGMENT_GAP
	return [
		[x0, y],
		[x0 + h, y - h],
		[x1 - h, y - h],
		[x1, y],
		[x1 - h, y + h],
		[x0 + h, y + h],
	]
}

function verticalSegment(x: number, top: number, bottom: number): Polygon {
	const h = SEGMENT / 2
	const y0 = top + SEGMENT_GAP
	const y1 = bottom - SEGMENT_GAP
	return [
		[x, y0],
		[x + h, y0 + h],
		[x + h, y1 - h],
		[x, y1],
		[x - h, y1 - h],
		[x - h, y0 + h],
	]
}

const h = SEGMENT / 2
const middle = DIGIT_HEIGHT / 2
// Segments a to g in the usual order: top, top right, bottom right, bottom,
// bottom left, top left, middle.
const SEGMENTS: readonly Polygon[] = [
	horizontalSegment(h),
	verticalSegment(DIGIT_WIDTH - h, h, middle),
	verticalSegment(DIGIT_WIDTH - h, middle, DIGIT_HEIGHT - h),
	horizontalSegment(DIGIT_HEIGHT - h),
	verticalSegment(h, middle, DIGIT_HEIGHT - h),
	verticalSegment(h, h, middle),
	horizontalSegment(middle),
].map(slant)

const LIT_SEGMENTS: readonly string[] = [
	'abcdef', // 0
	'bc',
	'abdeg',
	'abcdg',
	'bcfg',
	'acdfg',
	'acdefg',
	'abc',
	'abcdefg',
	'abcdfg', // 9
]

function contains(polygon: Polygon, x: number, y: number): boolean {
	let inside = false
	for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
		const [xi, yi] = polygon[i]!
		const [xj, yj] = polygon[j]!
		if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
			inside = !inside
		}
	}
	return inside
}

/** Supersampled coverage (0 to SAMPLES) of one polygon over a bitmap. */
function coverage(polygon: Polygon, width: number, height: number): Uint8Array {
	const out = new Uint8Array(width * height)
	const xs = polygon.map(([x]) => x)
	const ys = polygon.map(([, y]) => y)
	const left = Math.max(0, Math.floor(Math.min(...xs)))
	const right = Math.min(width, Math.ceil(Math.max(...xs)))
	const top = Math.max(0, Math.floor(Math.min(...ys)))
	const bottom = Math.min(height, Math.ceil(Math.max(...ys)))
	for (let y = top; y < bottom; y++) {
		for (let x = left; x < right; x++) {
			let hits = 0
			for (let sy = 0; sy < SUPERSAMPLE; sy++) {
				for (let sx = 0; sx < SUPERSAMPLE; sx++) {
					if (
						contains(
							polygon,
							x + (sx + 0.5) / SUPERSAMPLE,
							y + (sy + 0.5) / SUPERSAMPLE,
						)
					) {
						hits++
					}
				}
			}
			out[y * width + x] = hits
		}
	}
	return out
}

function litIndex(hits: number): number {
	const level = Math.round((hits / SAMPLES) * 4)
	return level === 0 ? CARD : [LIT_25, LIT_50, LIT_75, LIT][level - 1]!
}

type Bitmap = { width: number; height: number; pixels: Uint8Array }

let digitBitmaps: readonly Bitmap[] | undefined
let colonBitmap: Bitmap | undefined

/** The ten digits and the colon, rasterised once per server instance. */
function glyphs(): { digits: readonly Bitmap[]; colon: Bitmap } {
	if (!digitBitmaps || !colonBitmap) {
		const segmentCoverage = SEGMENTS.map((polygon) =>
			coverage(polygon, CELL_WIDTH, DIGIT_HEIGHT),
		)
		digitBitmaps = LIT_SEGMENTS.map((lit) => {
			const pixels = new Uint8Array(CELL_WIDTH * DIGIT_HEIGHT)
			for (let p = 0; p < pixels.length; p++) {
				let litHits = 0
				let ghostHits = 0
				segmentCoverage.forEach((hits, segment) => {
					if (lit.includes('abcdefg'[segment]!)) litHits += hits[p]!
					else ghostHits += hits[p]!
				})
				const index = litIndex(litHits)
				pixels[p] = index === CARD && ghostHits >= SAMPLES / 2 ? GHOST : index
			}
			return { width: CELL_WIDTH, height: DIGIT_HEIGHT, pixels }
		})

		// Centred once slanted, so the two dots follow the digits' italic.
		const dot = (cy: number): Polygon => {
			const cx = (COLON_WIDTH - SLANT_PAD) / 2
			return slant([
				[cx - h, cy - h],
				[cx + h, cy - h],
				[cx + h, cy + h],
				[cx - h, cy + h],
			])
		}
		const upper = coverage(dot(DIGIT_HEIGHT * 0.32), COLON_WIDTH, DIGIT_HEIGHT)
		const lower = coverage(dot(DIGIT_HEIGHT * 0.68), COLON_WIDTH, DIGIT_HEIGHT)
		const pixels = new Uint8Array(COLON_WIDTH * DIGIT_HEIGHT)
		for (let p = 0; p < pixels.length; p++) {
			pixels[p] = litIndex(upper[p]! + lower[p]!)
		}
		colonBitmap = { width: COLON_WIDTH, height: DIGIT_HEIGHT, pixels }
	}
	return { digits: digitBitmaps, colon: colonBitmap }
}

function blit(frame: Uint8Array, bitmap: Bitmap, left: number, top: number) {
	for (let y = 0; y < bitmap.height; y++) {
		frame.set(
			bitmap.pixels.subarray(y * bitmap.width, (y + 1) * bitmap.width),
			(top + y) * WIDTH + left,
		)
	}
}

function fillRect(
	frame: Uint8Array,
	left: number,
	top: number,
	width: number,
	height: number,
	index: number,
) {
	for (let y = top; y < top + height; y++) {
		frame.fill(index, y * WIDTH + left, y * WIDTH + left + width)
	}
}

function drawLabel(frame: Uint8Array, text: string, centerX: number) {
	const advance = (GLYPH_COLUMNS + LABEL_TRACKING) * LABEL_SCALE
	const width = text.length * advance - LABEL_TRACKING * LABEL_SCALE
	let x = Math.round(centerX - width / 2)
	for (const letter of text) {
		glyphRows(letter).forEach((row, rowIndex) => {
			for (let column = 0; column < GLYPH_COLUMNS; column++) {
				if (row[column] === '1') {
					fillRect(
						frame,
						x + column * LABEL_SCALE,
						LABEL_TOP + rowIndex * LABEL_SCALE,
						LABEL_SCALE,
						LABEL_SCALE,
						LABEL,
					)
				}
			}
		})
		x += advance
	}
}

type Layout = { digitLefts: number[] }

function drawStatic(frame: Uint8Array, withDays: boolean): Layout {
	fillRect(frame, 0, 0, WIDTH, HEIGHT, BORDER)
	fillRect(
		frame,
		BORDER_WIDTH,
		BORDER_WIDTH,
		WIDTH - BORDER_WIDTH * 2,
		HEIGHT - BORDER_WIDTH * 2,
		CARD,
	)

	const labels = withDays
		? ['DAYS', 'HOURS', 'MIN', 'SEC']
		: ['HOURS', 'MIN', 'SEC']
	const total =
		labels.length * GROUP_WIDTH + (labels.length - 1) * COLON_WIDTH + SLANT_PAD
	const start = Math.round((WIDTH - total) / 2)
	const { colon } = glyphs()
	const digitLefts: number[] = []
	labels.forEach((label, group) => {
		const left = start + group * (GROUP_WIDTH + COLON_WIDTH)
		digitLefts.push(left, left + DIGIT_WIDTH + DIGIT_SPACING)
		// The labels sit under the digits' slanted midline.
		drawLabel(frame, label, left + (GROUP_WIDTH + SLANT_PAD) / 2)
		if (group < labels.length - 1) {
			blit(frame, colon, left + GROUP_WIDTH, DIGITS_TOP)
		}
	})
	return { digitLefts }
}

function digitsFor(total: number, withDays: boolean): number[] {
	const { days, hours, minutes, seconds } = splitSeconds(total)
	const groups = withDays
		? [days, hours, minutes, seconds]
		: [hours, minutes, seconds]
	return groups.flatMap((value) => [...pad2(value)].map(Number))
}

/** The GIF for `total` seconds left. Zero or less renders the ended state. */
export function renderCountdownGif(total: number): Uint8Array<ArrayBuffer> {
	const seconds = frameSeconds(total)
	const withDays = showsDays(seconds[0]!)
	const { digits } = glyphs()

	const frame = new Uint8Array(WIDTH * HEIGHT)
	const { digitLefts } = drawStatic(frame, withDays)

	// Worst case LZW emits a 12-bit code per pixel; this bound covers it with
	// room for sub-block lengths and the per-frame headers.
	const cellArea = CELL_WIDTH * DIGIT_HEIGHT * digitLefts.length
	const buffer = new Uint8Array(
		2048 + WIDTH * HEIGHT * 2 + (seconds.length - 1) * (cellArea * 2 + 64),
	)
	const writer = new GifWriter(buffer, WIDTH, HEIGHT, {
		palette: [...PALETTE],
		// No `loop`: the GIF plays once and holds its last frame.
	})

	let shown: number[] = []
	for (const value of seconds) {
		const next = digitsFor(value, withDays)
		let left = WIDTH
		let right = 0
		next.forEach((digit, index) => {
			if (shown[index] === digit) return
			const x = digitLefts[index]!
			blit(frame, digits[digit]!, x, DIGITS_TOP)
			left = Math.min(left, x)
			right = Math.max(right, x + CELL_WIDTH)
		})

		const isFirst = shown.length === 0
		shown = next
		const x = isFirst ? 0 : left
		const y = isFirst ? 0 : DIGITS_TOP
		const width = isFirst ? WIDTH : right - left
		const height = isFirst ? HEIGHT : DIGIT_HEIGHT
		const region = new Uint8Array(width * height)
		for (let row = 0; row < height; row++) {
			const from = (y + row) * WIDTH + x
			region.set(frame.subarray(from, from + width), row * width)
		}
		// omggif's types say number[]; it only indexes, so a typed array works.
		writer.addFrame(x, y, width, height, region as unknown as number[], {
			delay: 100, // centiseconds
			disposal: 1, // keep this frame under the next one
		})
	}

	return buffer.slice(0, writer.end())
}
