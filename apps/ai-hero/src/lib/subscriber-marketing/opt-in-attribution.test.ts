import { describe, expect, it } from 'vitest'
import { isSyntheticOptInAttribution, parseOptInAttributionCookie } from './opt-in-attribution'

describe('opt-in attribution', () => {
	it('keeps only bounded signup attribution fields', () => {
		const value = parseOptInAttributionCookie(JSON.stringify({
			utm_source: 'google', utm_campaign: 'warmup', landing_path: '/skills',
			click_ids: { gclid: 'TEST_signup_1', fbclid: 'drop-me' },
			params: { secret: 'drop-me' }, captured_at: '2026-07-14T12:00:00.000Z',
		}))
		expect(value).toEqual({ utmSource: 'google', utmMedium: undefined, utmCampaign: 'warmup', utmContent: undefined, utmTerm: undefined, gclid: 'TEST_signup_1', gbraid: undefined, wbraid: undefined, landingPath: '/skills', referrer: undefined, capturedAt: '2026-07-14T12:00:00.000Z' })
		expect(isSyntheticOptInAttribution(value!)).toBe(true)
	})
	it('returns referrer when present and still works when absent', () => {
		const withReferrer = parseOptInAttributionCookie(JSON.stringify({
			landing_path: '/blog/post',
			referrer: 'https://www.google.com/search?q=ai+hero',
			captured_at: '2026-07-25T12:00:00.000Z',
		}))
		expect(withReferrer?.referrer).toBe('https://www.google.com/search?q=ai+hero')
		expect(withReferrer?.landingPath).toBe('/blog/post')

		const withoutReferrer = parseOptInAttributionCookie(JSON.stringify({
			landing_path: '/blog/post',
			captured_at: '2026-07-25T12:00:00.000Z',
		}))
		expect(withoutReferrer?.referrer).toBeUndefined()
		expect(withoutReferrer?.landingPath).toBe('/blog/post')
	})
	it('bounds long referrers to the 500-char path limit', () => {
		const longReferrer = `https://example.com/${'a'.repeat(600)}`
		const value = parseOptInAttributionCookie(JSON.stringify({
			referrer: longReferrer,
			captured_at: '2026-07-25T12:00:00.000Z',
		}))
		expect(value?.referrer).toHaveLength(500)
	})
	it('does not throw for malformed cookies', () => {
		expect(parseOptInAttributionCookie('{nope')).toBeUndefined()
		expect(parseOptInAttributionCookie(JSON.stringify({ captured_at: 'bad' }))).toBeUndefined()
	})
})
