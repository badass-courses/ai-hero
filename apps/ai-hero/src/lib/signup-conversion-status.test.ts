import { describe, expect, it } from 'vitest'
import { summarizeLocalSignupConversionStatus } from './signup-conversion-status'

describe('summarizeLocalSignupConversionStatus', () => {
	it('separates pending, uploaded, and failed real-gclid signups', () => {
		expect(
			summarizeLocalSignupConversionStatus({
				realGclidContactIds: ['new', 'processing', 'uploaded', 'validated', 'failed'],
				ledgerRows: [
					{ contactId: 'processing', status: 'processing' },
					{ contactId: 'uploaded', status: 'uploaded' },
					{ contactId: 'validated', status: 'validated' },
					{ contactId: 'failed', status: 'failed' },
				],
			}),
		).toEqual({
			recordedRealGclidSignups: 5,
			pending: 2,
			unrecorded: 1,
			processing: 1,
			uploaded: 2,
			failed: 1,
		})
	})
})
