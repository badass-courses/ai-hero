import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(
	new URL('./google-ads-conversion-upload.ts', import.meta.url),
	'utf8',
)

describe('Google Ads conversion upload schedule', () => {
	it('runs signup uploads only on the shared fifteen-minute cron', () => {
		expect(source).toContain("{ cron: '*/15 * * * *' }")
		expect(source).toContain("if (trigger.kind === 'purchase-event') {")
		expect(source).toContain("'process-google-ads-signup-conversion-uploads'")
		expect(source).toContain('processGoogleAdsSignupConversionUploads({')
	})

	it('logs aggregate purchase candidate, fallback, and result stages', () => {
		expect(source).toContain("stage: 'purchase-candidates'")
		expect(source).toContain("stage: 'purchase-fallback'")
		expect(source).toContain("stage: 'purchase-results'")
		expect(source).toContain(
			'byAttributionSource: purchases.byAttributionSource',
		)
	})

	it('keeps the production write gate and loudly skips a missing signup action', () => {
		expect(source).toContain('dryRun: !config.enabled')
		expect(source).toContain('includePreviewRows: false')
		expect(source).toContain(
			'GOOGLE_ADS_SIGNUP_CONVERSION_ACTION_RESOURCE_NAME?.trim()',
		)
		expect(source).toContain(
			"reason: 'missing-signup-conversion-action-resource'",
		)
		expect(source).toContain(
			"logger.warn('google_ads_conversion_upload.stage_skipped'",
		)
	})
})
