import { Effect } from 'effect'
import { describe, expect, it, vi } from 'vitest'

import {
	createDrovrParityReceiptSink,
	type DrovrParityTransitionReceipt,
} from './email-course-drovr-parity-receipt-sink'

const receipt: DrovrParityTransitionReceipt = {
	tenantId: 'org-aihero-shadow',
	contactId: 'contact-parity',
	journeyId: 'value-path-skills-course',
	journeyVersion: 1,
	fromState: 'email0.pending',
	toState: 'email0.pending',
	cause: 'journey.started',
	intentsEmitted: 1,
	at: '2026-09-01T16:00:00.000Z',
}

describe('retired Drovr parity receipt sink', () => {
	it('never schedules or posts parity work', async () => {
		const fetch = vi.fn()
		const schedule = vi.fn()
		const sink = createDrovrParityReceiptSink({
			config: {
				ingestUrl: 'https://drovr.test/events',
				apiKey: 'unused-test-key',
			},
			fetch,
			schedule,
		})

		await expect(Effect.runPromise(sink.push(receipt))).resolves.toBeUndefined()
		expect(schedule).not.toHaveBeenCalled()
		expect(fetch).not.toHaveBeenCalled()
	})
})
