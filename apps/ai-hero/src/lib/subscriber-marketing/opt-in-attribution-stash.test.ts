import { describe, expect, it } from 'vitest'

import type { OptInAttribution } from './opt-in-attribution'
import {
	AIH_OPTIN_ATTRIBUTION_FIELD,
	parseStashedOptInAttribution,
	serializeOptInAttributionForKit,
} from './opt-in-attribution-stash'

const paidAttribution: OptInAttribution = {
	utmSource: 'google',
	utmMedium: 'cpc',
	utmCampaign: 'email-course-warmup',
	utmTerm: 'matt pocock skills',
	gclid: 'Cj0KCQjw-example-gclid-value',
	landingPath: '/skills',
	capturedAt: '2026-07-24T15:00:00.000Z',
}

describe('opt-in attribution Kit stash', () => {
	it('round-trips paid attribution through the Kit field payload', () => {
		const serialized = serializeOptInAttributionForKit(paidAttribution)
		expect(serialized).toBeDefined()
		expect(serialized!.length).toBeLessThanOrEqual(1000)

		const parsed = parseStashedOptInAttribution({
			[AIH_OPTIN_ATTRIBUTION_FIELD]: serialized,
		})
		expect(parsed).toEqual(paidAttribution)
	})

	it('refuses payloads with no attribution signal', () => {
		expect(
			serializeOptInAttributionForKit({
				capturedAt: '2026-07-24T15:00:00.000Z',
			}),
		).toBeUndefined()
	})

	it('refuses payloads without a valid capture timestamp', () => {
		expect(
			serializeOptInAttributionForKit({
				gclid: 'Cj0KCQjw-example',
				capturedAt: 'not-a-date',
			}),
		).toBeUndefined()
	})

	it('drops the landing path before dropping click ids when the payload runs long', () => {
		const serialized = serializeOptInAttributionForKit({
			...paidAttribution,
			landingPath: `/${'x'.repeat(499)}`,
			utmContent: 'y'.repeat(255),
			utmTerm: 'z'.repeat(255),
		})
		expect(serialized).toBeDefined()
		const parsed = parseStashedOptInAttribution({
			[AIH_OPTIN_ATTRIBUTION_FIELD]: serialized,
		})
		expect(parsed?.gclid).toBe(paidAttribution.gclid)
		expect(parsed?.landingPath).toBeUndefined()
	})

	it('tolerates missing, blank, and malformed stashed values', () => {
		expect(parseStashedOptInAttribution(undefined)).toBeUndefined()
		expect(parseStashedOptInAttribution({})).toBeUndefined()
		expect(
			parseStashedOptInAttribution({ [AIH_OPTIN_ATTRIBUTION_FIELD]: '' }),
		).toBeUndefined()
		expect(
			parseStashedOptInAttribution({ [AIH_OPTIN_ATTRIBUTION_FIELD]: 'not-json' }),
		).toBeUndefined()
		expect(
			parseStashedOptInAttribution({ [AIH_OPTIN_ATTRIBUTION_FIELD]: null }),
		).toBeUndefined()
	})
})
