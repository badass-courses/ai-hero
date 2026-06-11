import { parsePostSlug } from '@/utils/parse-post-slug'
import { describe, expect, it } from 'vitest'

describe('parsePostSlug', () => {
	it('returns a bare slug as-is', () => {
		expect(parsePostSlug('build-first-agent')).toBe('build-first-agent')
	})

	it('strips a leading slash', () => {
		expect(parsePostSlug('/build-first-agent')).toBe('build-first-agent')
	})

	it('extracts slug from a production URL', () => {
		expect(parsePostSlug('https://www.aihero.dev/build-first-agent')).toBe(
			'build-first-agent',
		)
	})

	it('extracts slug from a /md/ URL', () => {
		expect(parsePostSlug('https://www.aihero.dev/md/build-first-agent')).toBe(
			'build-first-agent',
		)
	})

	it('strips a trailing slash', () => {
		expect(parsePostSlug('https://www.aihero.dev/build-first-agent/')).toBe(
			'build-first-agent',
		)
	})

	it('strips trailing .md', () => {
		expect(parsePostSlug('build-first-agent.md')).toBe('build-first-agent')
	})

	it('extracts slug from a localhost URL', () => {
		expect(parsePostSlug('http://localhost:3000/build-first-agent')).toBe(
			'build-first-agent',
		)
	})

	it('returns null for empty input', () => {
		expect(parsePostSlug('')).toBeNull()
		expect(parsePostSlug('   ')).toBeNull()
	})

	it('returns null for nested paths (multiple segments)', () => {
		expect(parsePostSlug('https://www.aihero.dev/workshops/foo/bar')).toBeNull()
	})

	it('returns null for malformed URL', () => {
		expect(parsePostSlug('https://')).toBeNull()
	})
})
