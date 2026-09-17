import { validateHeaderValue } from 'node:http'

import { encodeCacheTag } from 'next/dist/server/lib/encode-cache-tag'
import { describe, expect, it } from 'vitest'

import { parsePublicContentSlug } from './public-content-slug'

describe('parsePublicContentSlug', () => {
	it.each([
		'build-first-agent',
		'skills—discussed',
		'вот',
		'技能介绍',
		'agent-🧠',
		'format-\u200D-character',
	])('preserves valid public slug %s', (slug) => {
		expect(parsePublicContentSlug(slug)).toBe(slug)
	})

	it.each([
		'',
		'nested/path',
		'a-complete-guide-to-agents-md\n',
		'skills\u0000catalog',
		'grill-with-doc\uE000s',
	])('rejects unsafe public slug %j', (slug) => {
		expect(parsePublicContentSlug(slug)).toBeNull()
	})

	it('rejects the observed encoded private-use path', () => {
		const slug = decodeURIComponent('grill-with-doc%EE%80%80s')

		expect(parsePublicContentSlug(slug)).toBeNull()
	})

	it('keeps valid Unicode cache-tag paths header-safe', () => {
		const slug = decodeURIComponent('skills%E2%80%94discussed')
		const parsed = parsePublicContentSlug(slug)

		expect(parsed).toBe(slug)
		if (!parsed) throw new Error('expected a valid Unicode slug')
		expect(() =>
			validateHeaderValue('x-next-cache-tags', encodeCacheTag(parsed)),
		).not.toThrow()
	})

	it('makes the observed private-use cache tag header-safe before rejection', () => {
		const path = '/grill-with-doc\uE000s'

		expect(() => validateHeaderValue('x-next-cache-tags', path)).toThrow()
		expect(() =>
			validateHeaderValue('x-next-cache-tags', encodeCacheTag(path)),
		).not.toThrow()
	})
})
