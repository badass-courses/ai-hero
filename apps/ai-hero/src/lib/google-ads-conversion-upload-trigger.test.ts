import { describe, expect, it } from 'vitest'
import { classifyGoogleAdsUploadTrigger } from './google-ads-conversion-upload-trigger'

const purchaseEvent = 'commerce/new-purchase-created'

describe('Google Ads upload trigger classification', () => {
	it('classifies a scheduled event as the signup-capable cron', () => {
		expect(
			classifyGoogleAdsUploadTrigger(
				{ name: 'inngest/scheduled.timer' },
				purchaseEvent,
			),
		).toEqual({ kind: 'scheduled-cron' })
	})

	it('keeps malformed purchase events out of the signup path', () => {
		expect(
			classifyGoogleAdsUploadTrigger(
				{ name: purchaseEvent, data: {} },
				purchaseEvent,
			),
		).toEqual({ kind: 'purchase-event' })
	})

	it('returns a trimmed purchase id for a valid purchase event', () => {
		expect(
			classifyGoogleAdsUploadTrigger(
				{ name: purchaseEvent, data: { purchaseId: ' purchase_1 ' } },
				purchaseEvent,
			),
		).toEqual({ kind: 'purchase-event', purchaseId: 'purchase_1' })
	})
})
