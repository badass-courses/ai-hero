import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { metaDescription, plainDescription } from './meta-description'

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
		['one <script>alert(1)</script> <style>bad</style> two', 'one two'],
		[
			'<h1>Keep Mixed Case</h1><p>Text<img src="x" alt="not description" /></p>',
			'Keep Mixed Case Text',
		],
		['<p>one<script>bad</script><style>bad</style> two</p>', 'one two'],
	])('strips markdown/HTML and decodes entities: %s', (source, expected) => {
		expect(metaDescription(source)).toBe(expected)
	})
	it('does not cut fundamentals mid-word', () => {
		expect(metaDescription('Learn software engineering fundamentals', 33)).toBe(
			'Learn software engineering…',
		)
	})
	it.each([
		undefined,
		null,
		'',
		'   ',
		'<script>bad</script>',
		'<img src="x" />',
	])('omits empty input %s', (source) => {
		expect(metaDescription(source)).toBeUndefined()
	})
	it('adds an ellipsis only when cut, trims punctuation, and hard-cuts an overlong first word', () => {
		expect(metaDescription('hello world', 11)).toBe('hello world')
		expect(metaDescription('hello world', 10)).toBe('hello…')
		expect(metaDescription('fundamentals', 5)).toBe('fund…')
		expect(metaDescription('hello, this continues', 8)).toBe('hello…')
		expect(metaDescription('hello', 0)).toBeUndefined()
		expect(() => metaDescription('hello', -1)).toThrow()
	})
	it('keeps full dictionary text and does not parse already-plain data twice', () => {
		const source = 'word '.repeat(60) + '`*literal*`'
		const full = plainDescription(source)
		expect(full.length).toBeGreaterThan(155)
		expect(full).toContain('*literal*')
		expect(metaDescription('*literal*', 155, { plainText: true })).toBe(
			'*literal*',
		)
	})
	it('preserves a bounded prefix across generated Markdown, HTML and entities', () => {
		const word = fc.stringMatching(/^[a-zA-Z]{1,40}$/)
		fc.assert(
			fc.property(
				fc.array(word, { minLength: 1, maxLength: 100 }),
				fc.integer({ min: 1, max: 155 }),
				fc.boolean(),
				(words, limit, html) => {
					const plain = words.join(' ') + ' & more'
					const source = html
						? `<h2>${words.join(' ')}</h2><p>&amp; more<img src="x" alt="skip" /><script>skip</script><style>skip</style></p>`
						: words
								.map((word, i) =>
									i % 2 ? `*${word}*` : `[${word}](https://example.test)`,
								)
								.join(' ') + ' &amp; more'
					const output = metaDescription(source, limit)!
					expect(output.length).toBeLessThanOrEqual(limit)
					expect(output).not.toMatch(/[*_`<>\[\]]|&(?:a|am|amp)$/)
					if (plain.length <= limit) expect(output).toBe(plain)
					else {
						expect(output.endsWith('…')).toBe(true)
						const prefix = output.slice(0, -1)
						expect(plain.startsWith(prefix)).toBe(true)
						expect(
							prefix === '' ||
								plain[prefix.length] === ' ' ||
								words[0]!.length >= limit,
						).toBe(true)
					}
				},
			),
			{ numRuns: 2000, seed: 20261016 },
		)
	})
})
