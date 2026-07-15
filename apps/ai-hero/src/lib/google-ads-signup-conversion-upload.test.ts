import { describe, expect, it } from 'vitest'
import { buildSignupConversionPreview, prepareSignupConversionBatch } from './google-ads-signup-conversion-upload'

const action = 'customers/3867214797/conversionActions/123'
const base = { contactId: 'contact_1', occurredAt: '2026-07-14T12:00:00.000Z', attribution: { capturedAt: '2026-07-14T11:00:00.000Z' } }

describe('signup conversion preparation', () => {
	it('shows TEST_ evidence in preview while excluding it from upload', () => {
		const candidates = [{ ...base, attribution: { ...base.attribution, gclid: 'TEST_signup', subscribedAt: '2026-07-14T12:00:00.000Z' } }]
		const preview = buildSignupConversionPreview(candidates)
		expect(preview.counts).toEqual({ scanned: 1, withClickEvidence: 1, synthetic: 1, real: 0 })
		expect(preview.rows).toEqual([{ clickIdType: 'gclid', synthetic: true, conversionTime: '2026-07-14T12:00:00.000Z' }])
		const result = prepareSignupConversionBatch({ candidates, conversionActionResourceName: action })
		expect(result.counts).toEqual({ scanned: 1, eligible: 0, excluded: { 'synthetic-click-id': 1 } })
	})
	it('prepares a real fixture without writing or exposing it in the summary', () => {
		const result = prepareSignupConversionBatch({ candidates: [{ ...base, attribution: { ...base.attribution, gclid: 'real-fixture-click' } }], conversionActionResourceName: action })
		expect(result.counts.eligible).toBe(1)
		expect(result.prepared[0]).toMatchObject({ clickIdType: 'gclid', conversionValue: 0, currencyCode: 'USD' })
		expect(JSON.stringify(result.prepared[0]?.requestSummary)).not.toContain('real-fixture-click')
	})
	it('requires a configured live conversion action resource', () => {
		const result = prepareSignupConversionBatch({ candidates: [{ ...base, attribution: { ...base.attribution, gclid: 'real-fixture-click' } }] })
		expect(result.counts.excluded).toEqual({ 'missing-conversion-action-resource': 1 })
	})
})
