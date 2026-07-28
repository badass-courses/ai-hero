import { describe, expect, it, vi } from 'vitest'
import type {
	GoogleAdsConversionUploadConfig,
	GoogleAdsUploadClientResult,
} from './google-ads-conversion-upload'
import {
	buildSignupConversionPreview,
	prepareSignupConversionBatch,
	processPreparedGoogleAdsSignupConversions,
	type SignupConversionLedger,
} from './google-ads-signup-conversion-upload'

const action = 'customers/3867214797/conversionActions/123'
const base = {
	contactId: 'contact_1',
	occurredAt: '2026-07-14T12:00:00.000Z',
	attribution: { capturedAt: '2026-07-14T11:00:00.000Z' },
}
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

function memoryLedger(): SignupConversionLedger {
	const reserved = new Set<string>()
	return {
		reserve: vi.fn(async ({ conversion }) => {
			if (reserved.has(conversion.idempotencyKey)) return 'idempotent-noop'
			reserved.add(conversion.idempotencyKey)
			return 'reserved'
		}),
		recordResult: vi.fn(async () => undefined),
		recordThrownError: vi.fn(async () => undefined),
	}
}

function validationAwareMemoryLedger(): SignupConversionLedger {
	const statuses = new Map<string, string>()
	return {
		reserve: vi.fn(async ({ conversion, uploadValidated }) => {
			const status = statuses.get(conversion.idempotencyKey)
			if (!status || (status === 'validated' && uploadValidated)) {
				statuses.set(conversion.idempotencyKey, 'processing')
				return 'reserved'
			}
			return 'idempotent-noop'
		}),
		recordResult: vi.fn(async ({ conversion, result }) => {
			statuses.set(conversion.idempotencyKey, result.status)
		}),
		recordThrownError: vi.fn(async ({ conversion }) => {
			statuses.set(conversion.idempotencyKey, 'failed')
		}),
	}
}

describe('signup conversion preparation', () => {
	it('shows TEST_ evidence in preview while excluding it from upload', () => {
		const candidates = [
			{
				...base,
				attribution: {
					...base.attribution,
					gclid: 'TEST_signup',
					subscribedAt: '2026-07-14T12:00:00.000Z',
				},
			},
		]
		const preview = buildSignupConversionPreview(candidates)
		expect(preview.counts).toEqual({
			scanned: 1,
			withClickEvidence: 1,
			synthetic: 1,
			real: 0,
		})
		expect(preview.rows).toEqual([
			{
				clickIdType: 'gclid',
				synthetic: true,
				conversionTime: '2026-07-14T12:00:00.000Z',
			},
		])
		const result = prepareSignupConversionBatch({
			candidates,
			conversionActionResourceName: action,
		})
		expect(result.counts).toEqual({
			scanned: 1,
			eligible: 0,
			excluded: { 'synthetic-click-id': 1 },
		})
	})

	it('prepares a real fixture without exposing the click id in the summary', () => {
		const result = prepareSignupConversionBatch({
			candidates: [
				{
					...base,
					attribution: {
						...base.attribution,
						gclid: 'real-fixture-click',
					},
				},
			],
			conversionActionResourceName: action,
		})
		expect(result.counts.eligible).toBe(1)
		expect(result.prepared[0]).toMatchObject({
			clickIdType: 'gclid',
			conversionValue: 0,
			currencyCode: 'USD',
		})
		expect(JSON.stringify(result.prepared[0]?.requestSummary)).not.toContain(
			'real-fixture-click',
		)
	})

	it('requires a configured live conversion action resource', () => {
		const result = prepareSignupConversionBatch({
			candidates: [
				{
					...base,
					attribution: {
						...base.attribution,
						gclid: 'real-fixture-click',
					},
				},
			],
		})
		expect(result.counts.excluded).toEqual({
			'missing-conversion-action-resource': 1,
		})
	})
})

describe('signup conversion processing', () => {
	const candidates = [
		{
			...base,
			attribution: {
				...base.attribution,
				gclid: 'real-fixture-click',
			},
		},
	]

	it('uses the idempotency ledger to prevent a second upload', async () => {
		const ledger = memoryLedger()
		const upload = vi.fn(async () => ({
			status: 'uploaded' as const,
			responseSummary: { resultCount: 1 },
		}))
		const first = await processPreparedGoogleAdsSignupConversions({
			candidates,
			conversionActionResourceName: action,
			config,
			uploadClient: { upload },
			ledger,
			dryRun: false,
		})
		const second = await processPreparedGoogleAdsSignupConversions({
			candidates,
			conversionActionResourceName: action,
			config,
			uploadClient: { upload },
			ledger,
			dryRun: false,
		})

		expect(first).toMatchObject({ uploaded: 1, idempotentNoop: 0 })
		expect(second).toMatchObject({ uploaded: 0, idempotentNoop: 1 })
		expect(upload).toHaveBeenCalledTimes(1)
	})

	it('uploads a previously validated conversion after validate-only is disabled', async () => {
		const ledger = validationAwareMemoryLedger()
		const upload = vi
			.fn()
			.mockResolvedValueOnce({
				status: 'validated' as const,
				responseSummary: { resultCount: 1 },
			})
			.mockResolvedValueOnce({
				status: 'uploaded' as const,
				responseSummary: { resultCount: 1 },
			})
		const validated = await processPreparedGoogleAdsSignupConversions({
			candidates,
			conversionActionResourceName: action,
			config: { ...config, validateOnly: true },
			uploadClient: { upload },
			ledger,
			dryRun: false,
		})
		const uploaded = await processPreparedGoogleAdsSignupConversions({
			candidates,
			conversionActionResourceName: action,
			config: { ...config, validateOnly: false },
			uploadClient: { upload },
			ledger,
			dryRun: false,
		})

		expect(validated).toMatchObject({ validated: 1, uploaded: 0 })
		expect(uploaded).toMatchObject({ validated: 0, uploaded: 1 })
		expect(upload).toHaveBeenCalledTimes(2)
	})

	it('does not reserve or upload in dry-run mode', async () => {
		const ledger = memoryLedger()
		const upload = vi.fn()
		const result = await processPreparedGoogleAdsSignupConversions({
			candidates,
			conversionActionResourceName: action,
			config: { ...config, enabled: false },
			uploadClient: { upload },
			ledger,
			dryRun: true,
		})

		expect(result).toMatchObject({
			mode: 'dry-run',
			eligible: 1,
			dryRunEligible: 1,
		})
		expect(ledger.reserve).not.toHaveBeenCalled()
		expect(upload).not.toHaveBeenCalled()
	})

	it('records a failed response without throwing the whole batch', async () => {
		const ledger = memoryLedger()
		const failed: GoogleAdsUploadClientResult = {
			status: 'failed',
			responseSummary: { resultCount: 0 },
		}
		const result = await processPreparedGoogleAdsSignupConversions({
			candidates,
			conversionActionResourceName: action,
			config,
			uploadClient: { upload: vi.fn(async () => failed) },
			ledger,
			dryRun: false,
		})

		expect(result).toMatchObject({ failed: 1, uploaded: 0 })
		expect(ledger.recordResult).toHaveBeenCalledWith(
			expect.objectContaining({ result: failed }),
		)
	})
})
