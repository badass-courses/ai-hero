import { describe, expect, it } from 'vitest'

import {
	formatGoogleAdsConversionDateTime,
	prepareGoogleAdsConversion,
	selectGoogleClickId,
} from './google-ads-conversion-upload'

describe('google ads conversion upload helpers', () => {
	it('selects exactly one real Google click id with gclid priority', () => {
		expect(
			selectGoogleClickId({
				clickIds: {
					gclid: ' gclid-123 ',
					gbraid: 'gbraid-456',
				},
			}),
		).toEqual({ type: 'gclid', value: 'gclid-123' })
	})

	it('ignores synthetic TEST click ids', () => {
		expect(
			selectGoogleClickId({
				clickIds: {
					gclid: 'TEST_FAKE_CLICK',
				},
			}),
		).toBeUndefined()
	})

	it('formats conversion time in Google Ads UTC offset format', () => {
		expect(formatGoogleAdsConversionDateTime('2026-05-28T16:12:26.953Z')).toBe(
			'2026-05-28 16:12:26+00:00',
		)
	})

	it('prepares a privacy-safe click conversion summary from purchase attribution', () => {
		const result = prepareGoogleAdsConversion({
			conversionActionResourceName:
				'customers/3867214797/conversionActions/7622646601',
			purchase: {
				id: 'purchase_123',
				createdAt: '2026-05-28T16:12:26.953Z',
				productId: 'product-pqkk5',
				status: 'Valid',
				totalAmount: 697,
				fields: {
					attribution: {
						utm: {
							source: 'google',
							medium: 'cpc',
							campaign: 'c004_brand_defense',
						},
						clickIds: {
							gclid: 'real-click-id',
						},
					},
				},
			},
		})

		expect(result.ok).toBe(true)
		if (!result.ok) return
		expect(result.conversion).toMatchObject({
			purchaseId: 'purchase_123',
			clickIdType: 'gclid',
			conversionValue: 697,
			currencyCode: 'USD',
			orderId: 'purchase_123',
		})
		expect(result.conversion.clickIdHash).toHaveLength(64)
		expect(result.conversion.requestSummary).not.toHaveProperty('clickIdValue')
	})
})
