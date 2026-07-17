import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(
	new URL('./google-ads-signup-conversion-upload.ts', import.meta.url),
	'utf8',
)
const queryStart = source.indexOf(
	'export async function fetchGoogleAdsSignupConversionCandidates',
)
const queryEnd = source.indexOf(
	'export async function processPreparedGoogleAdsSignupConversions',
)
const query = source.slice(queryStart, queryEnd)

describe('signup conversion candidate query', () => {
	it('filters attribution, range, synthetic ids, and existing ledger rows before limiting', () => {
		expect(query).toContain("'$.subscribedAt'")
		expect(query).toContain("'$.gclid'")
		expect(query).toContain("<> 'TEST_'")
		expect(query).toContain('args.since.toISOString()')
		expect(query).toContain('isNull(googleAdsSignupConversionUpload.id)')
		expect(query).toContain("'validated'")
		expect(query.indexOf('.where(')).toBeLessThan(query.indexOf('.limit('))
	})
})
