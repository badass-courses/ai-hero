import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { KEYWORD_QUERY_PARAMS } from './search-query-params'

describe('KEYWORD_QUERY_PARAMS', () => {
	it('does not search the provider-embedded field', () => {
		expect(KEYWORD_QUERY_PARAMS.query_by.split(',')).not.toContain('embedding')
	})

	it('has one prefix value per query_by field', () => {
		expect(KEYWORD_QUERY_PARAMS.prefix.split(',')).toHaveLength(
			KEYWORD_QUERY_PARAMS.query_by.split(',').length,
		)
	})

	it.each([
		'app/(search)/q/_components/search.tsx',
		'app/(content)/videos/_components/video-search.tsx',
	])('%s uses the shared keyword params', (file) => {
		const source = readFileSync(join(__dirname, '..', file), 'utf8')
		expect(source).toContain('KEYWORD_QUERY_PARAMS')
		expect(source).not.toMatch(/query_by:\s*'[^']*embedding/)
	})
})
