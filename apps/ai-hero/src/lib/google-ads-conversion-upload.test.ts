import { describe, expect, it, vi } from 'vitest'

import {
	formatGoogleAdsConversionDateTime,
	isClickWithinGoogleUploadWindow,
	prepareGoogleAdsConversion,
	processGoogleAdsConversionUploads,
	selectGoogleClickId,
	type GoogleAdsConversionUploadConfig,
	type GoogleAdsPurchaseConversionLedger,
	type PurchaseRow,
} from './google-ads-conversion-upload'

const action = 'customers/3867214797/conversionActions/7622646601'
const config: GoogleAdsConversionUploadConfig = {
	enabled: true,
	validateOnly: false,
	customerId: '3867214797',
	developerToken: 'developer-token',
	clientId: 'client-id',
	clientSecret: 'client-secret',
	refreshToken: 'refresh-token',
	conversionActionResourceName: action,
	retryDelayMs: 0,
	maxAttempts: 5,
}

function memoryLedger(): GoogleAdsPurchaseConversionLedger {
	const reserved = new Set<string>()
	return {
		reserve: vi.fn(async ({ conversion }) => {
			if (reserved.has(conversion.idempotencyKey)) {
				return { status: 'idempotent-noop' as const }
			}
			reserved.add(conversion.idempotencyKey)
			return { status: 'reserved' as const, attemptCount: 1 }
		}),
		recordResult: vi.fn(async () => undefined),
		recordThrownError: vi.fn(async () => undefined),
	}
}

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

	it('never turns synthetic checkout attribution into a real fallback upload', () => {
		const result = prepareGoogleAdsConversion({
			conversionActionResourceName: action,
			purchase: {
				id: 'purchase_test',
				createdAt: '2026-07-17T12:00:00.000Z',
				productId: 'product-pqkk5',
				status: 'Valid',
				totalAmount: 697,
				fields: {
					attribution: {
						synthetic: true,
						clickIds: { gclid: 'TEST_FAKE_CLICK' },
					},
				},
			},
			fallback: {
				clickIdValue: 'real-stored-signup-gclid',
				capturedAt: '2026-07-01T12:00:00.000Z',
				resolution: 'buyer-email',
			},
		})

		expect(result).toEqual({
			ok: false,
			reason: 'synthetic-google-click-id',
		})
	})

	it('formats conversion time in Google Ads UTC offset format', () => {
		expect(formatGoogleAdsConversionDateTime('2026-05-28T16:12:26.953Z')).toBe(
			'2026-05-28 16:12:26+00:00',
		)
	})

	it('prepares a privacy-safe click conversion summary from purchase attribution', () => {
		const result = prepareGoogleAdsConversion({
			conversionActionResourceName: action,
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
			attributionSource: 'checkout',
			conversionValue: 697,
			currencyCode: 'USD',
			orderId: 'purchase_123',
		})
		expect(result.conversion.clickIdHash).toHaveLength(64)
		expect(result.conversion.requestSummary).not.toHaveProperty('clickIdValue')
	})

	it('uses a stored signup gclid only when the direct checkout click is missing and within 90 days', () => {
		const result = prepareGoogleAdsConversion({
			conversionActionResourceName: action,
			purchase: {
				id: 'purchase_fallback',
				createdAt: '2026-07-17T12:00:00.000Z',
				productId: 'product-pqkk5',
				status: 'Valid',
				totalAmount: 697,
				fields: { attribution: { kitSubscriberId: 'kit_123' } },
			},
			fallback: {
				clickIdValue: 'stored-signup-gclid',
				capturedAt: '2026-05-01T12:00:00.000Z',
				resolution: 'kit-provider-identity',
			},
		})

		expect(result.ok).toBe(true)
		if (!result.ok) return
		expect(result.conversion).toMatchObject({
			clickIdType: 'gclid',
			attributionSource: 'signup-gclid-fallback',
			requestSummary: {
				attributionSource: 'signup-gclid-fallback',
				fallbackResolution: 'kit-provider-identity',
			},
		})
		expect(JSON.stringify(result.conversion.requestSummary)).not.toContain(
			'stored-signup-gclid',
		)
	})

	it('rejects a signup gclid outside the 90-day click window', () => {
		expect(
			isClickWithinGoogleUploadWindow({
				clickAt: '2026-04-01T00:00:00.000Z',
				conversionAt: '2026-07-17T00:00:00.000Z',
			}),
		).toBe(false)
	})

	it('replays one purchase under two sources without uploading twice', async () => {
		const ledger = memoryLedger()
		const upload = vi.fn(async () => ({
			status: 'uploaded' as const,
			responseSummary: { resultCount: 1 },
		}))
		const purchase: PurchaseRow = {
			id: 'purchase_replay',
			createdAt: '2026-07-17T12:00:00.000Z',
			productId: 'product-pqkk5',
			status: 'Valid',
			totalAmount: 697,
			fields: { attribution: { kitSubscriberId: 'kit_123' } },
		}
		const fallbackResolver = vi.fn(async () => ({
			ok: true as const,
			fallback: {
				clickIdValue: 'stored-signup-gclid',
				capturedAt: '2026-07-01T12:00:00.000Z',
				resolution: 'kit-provider-identity' as const,
			},
		}))

		const first = await processGoogleAdsConversionUploads({
			candidates: [purchase],
			config,
			fallbackResolver,
			ledger,
			uploadClient: { upload },
			dryRun: false,
		})
		purchase.fields = {
			attribution: { clickIds: { gclid: 'late-checkout-gclid' } },
		}
		const second = await processGoogleAdsConversionUploads({
			candidates: [purchase],
			config,
			fallbackResolver,
			ledger,
			uploadClient: { upload },
			dryRun: false,
		})

		expect(first).toMatchObject({
			uploaded: 1,
			fallbackResolved: 1,
			byAttributionSource: { 'signup-gclid-fallback': 1 },
		})
		expect(second).toMatchObject({
			uploaded: 0,
			byAttributionSource: { checkout: 1 },
			byReason: { 'ledger-idempotent-noop': 1 },
		})
		expect(upload).toHaveBeenCalledTimes(1)
	})

	it('never invokes the fallback resolver when checkout has a valid click id', async () => {
		const fallbackResolver = vi.fn()
		const result = await processGoogleAdsConversionUploads({
			candidates: [
				{
					id: 'purchase_checkout',
					createdAt: '2026-07-17T12:00:00.000Z',
					productId: 'product-pqkk5',
					status: 'Valid',
					totalAmount: 697,
					fields: { attribution: { clickIds: { gclid: 'checkout-click' } } },
				},
			],
			config,
			fallbackResolver,
			dryRun: true,
		})

		expect(result.byAttributionSource).toEqual({ checkout: 1 })
		expect(fallbackResolver).not.toHaveBeenCalled()
	})
})
