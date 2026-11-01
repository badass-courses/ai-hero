import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { DARK_TOKENS, flatten, type DarkToken } from './tokens'

const css = readFileSync(
	new URL('../../styles/globals.css', import.meta.url),
	'utf8',
)

function darkTokenValue(token: DarkToken): string | undefined {
	const block = /\n\.dark\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? ''
	const name = token.replace(/[-]/g, '\\-')
	return new RegExp(`\\n\\s*${name}:\\s*([^;]+);`).exec(block)?.[1]?.trim()
}

describe('email countdown colours', () => {
	it.each(Object.keys(DARK_TOKENS) as DarkToken[])(
		'%s matches the dark theme in globals.css',
		(token) => {
			expect(DARK_TOKENS[token]).toBe(darkTokenValue(token))
		},
	)

	it('flattens alpha tokens over the card', () => {
		expect(flatten('rgba(255, 255, 255, 0.08)', '#100f0e')).toEqual([
			35, 34, 33,
		])
		expect(flatten('#f5c451', '#100f0e')).toEqual([245, 196, 81])
	})
})
