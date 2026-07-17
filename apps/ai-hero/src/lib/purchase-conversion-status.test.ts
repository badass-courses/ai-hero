import { describe, expect, it } from 'vitest'
import { summarizeUploadedPurchasesByAttributionSource } from './purchase-conversion-status'

describe('purchase conversion status', () => {
	it('splits uploaded purchase conversions by honest attribution source', () => {
		expect(
			summarizeUploadedPurchasesByAttributionSource([
				{ attributionSource: 'checkout', status: 'uploaded' },
				{ attributionSource: 'signup-gclid-fallback', status: 'uploaded' },
				{ attributionSource: 'signup-gclid-fallback', status: 'validated' },
			]),
		).toEqual({
			uploaded: 2,
			uploadedByAttributionSource: {
				checkout: 1,
				'signup-gclid-fallback': 1,
			},
		})
	})
})
