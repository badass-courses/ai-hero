import { describe, expect, it } from 'vitest'
import { isSyntheticOptInAttribution, parseOptInAttributionCookie } from './opt-in-attribution'

describe('opt-in attribution', () => {
	it('keeps only bounded signup attribution fields', () => {
		const value = parseOptInAttributionCookie(JSON.stringify({
			utm_source: 'google', utm_campaign: 'warmup', landing_path: '/skills',
			click_ids: { gclid: 'TEST_signup_1', fbclid: 'drop-me' },
			params: { secret: 'drop-me' }, captured_at: '2026-07-14T12:00:00.000Z',
		}))
		expect(value).toEqual({ utmSource: 'google', utmMedium: undefined, utmCampaign: 'warmup', utmContent: undefined, utmTerm: undefined, gclid: 'TEST_signup_1', gbraid: undefined, wbraid: undefined, landingPath: '/skills', capturedAt: '2026-07-14T12:00:00.000Z' })
		expect(isSyntheticOptInAttribution(value!)).toBe(true)
	})
	it('does not throw for malformed cookies', () => {
		expect(parseOptInAttributionCookie('{nope')).toBeUndefined()
		expect(parseOptInAttributionCookie(JSON.stringify({ captured_at: 'bad' }))).toBeUndefined()
	})
})
