/**
 * A 5x7 dot-matrix font for the countdown GIF's labels, so the serverless
 * runtime never needs a font file. It holds only the letters the labels use;
 * `drawLabel` throws on anything else, which keeps arbitrary text out.
 */
export const GLYPH_COLUMNS = 5
export const GLYPH_ROWS = 7

const GLYPHS: Record<string, readonly string[]> = {
	A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
	C: ['01110', '10001', '10000', '10000', '10000', '10001', '01110'],
	D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
	E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
	H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
	I: ['11111', '00100', '00100', '00100', '00100', '00100', '11111'],
	M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
	N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
	O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
	R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
	S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
	U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
	Y: ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
}

export function glyphRows(letter: string): readonly string[] {
	const rows = GLYPHS[letter]
	if (!rows) throw new Error(`No pixel-font glyph for "${letter}"`)
	return rows
}
