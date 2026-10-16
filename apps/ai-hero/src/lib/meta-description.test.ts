import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { metaDescription } from './meta-description'

describe('metaDescription', () => {
	it.each([
		['# Learn *you* and **agents**', 'Learn you and agents'],
		[
			'Use [the SDK](https://example.test) and `code`.',
			'Use the SDK and code.',
		],
		['<p>AI &amp; engineering &#x1f680;</p>', 'AI & engineering 🚀'],
		['> Ship ~~bad~~ better\n\n- software', 'Ship bad better software'],
		['[agents][ref]\n\n[ref]: https://example.test', 'agents'],
		['![cover](image.png)\n\nHello', 'Hello'],
		['one\n\n<script>alert(1)</script>\n\ntwo', 'one two'],
	])('strips markdown/HTML and decodes entities: %s', (source, expected) => {
		expect(metaDescription(source)).toBe(expected)
	})
	it('does not cut fundamentals mid-word', () => {
		expect(metaDescription('Learn software engineering fundamentals', 33)).toBe(
			'Learn software engineering…',
		)
	})
	it.each([undefined, null, ''])('handles empty input %s', (source) => {
		expect(metaDescription(source)).toBe('')
	})
	it('only adds an ellipsis when cut, including exact fits and long first words', () => {
		expect(metaDescription('hello world', 11)).toBe('hello world')
		expect(metaDescription('hello world', 10)).toBe('hello…')
		expect(metaDescription('fundamentals', 5)).toBe('…')
		expect(metaDescription('hello', 0)).toBe('')
		expect(() => metaDescription('hello', -1)).toThrow()
	})
	it('preserves a bounded whole-word prefix across generated markdown and entities', () => {
		const word = fc.stringMatching(/^[a-zA-Z]{1,40}$/)
		fc.assert(
			fc.property(
				fc.array(word, { minLength: 1, maxLength: 100 }),
				fc.integer({ min: 1, max: 155 }),
				(words, limit) => {
					const plain = words.join(' ') + ' & more'
					const source =
						words
							.map((word, i) =>
								i % 2 ? `*${word}*` : `[${word}](https://example.test)`,
							)
							.join(' ') + ' &amp; more'
					const output = metaDescription(source, limit)
					expect(output.length).toBeLessThanOrEqual(limit)
					expect(output).not.toMatch(/[*_`<>\[\]]|&(?:a|am|amp)$/)
					if (plain.length <= limit) expect(output).toBe(plain)
					else {
						expect(output.endsWith('…')).toBe(true)
						const prefix = output.slice(0, -1)
						expect(plain.startsWith(prefix)).toBe(true)
						expect(prefix === '' || plain[prefix.length] === ' ').toBe(true)
					}
				},
			),
			{ numRuns: 2000, seed: 20261016 },
		)
	})
})
