import { Effect } from 'effect'
import { describe, expect, it, vi } from 'vitest'

import {
	createDrovrParityReceiptSink,
	deriveDrovrParityTransitionUrl,
	emitDrovrParityReceipt,
	type DrovrParityTransitionReceipt,
} from './email-course-drovr-parity-receipt-sink'

const receipt: DrovrParityTransitionReceipt = {
	tenantId: 'org-aihero-shadow',
	contactId: 'contact-parity',
	journeyId: 'value-path-skills-course',
	journeyVersion: 1,
	fromState: 'entry',
	toState: 'email0.pending',
	cause: 'journey.started',
	intentsEmitted: 1,
	at: '2026-09-01T16:00:00.000Z',
}

describe('Drovr parity receipt sink', () => {
	it('derives the parity path from the configured shadow ingest host', () => {
		expect(
			deriveDrovrParityTransitionUrl(
				'https://drovr-api.wzrrd.sh/events/ingest?source=aihero',
			),
		).toBe('https://drovr-api.wzrrd.sh/parity/transitions')
	})

	it('reuses the shadow bearer key and posts the normalized receipt', async () => {
		const fetch = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ matched: true, recorded: true }), {
				status: 200,
				headers: { 'content-type': 'application/json' },
			}),
		)

		await emitDrovrParityReceipt(receipt, {
			config: {
				ingestUrl: 'https://drovr-api.wzrrd.sh/events',
				apiKey: 'shadow-secret',
			},
			fetch,
		})

		expect(fetch).toHaveBeenCalledOnce()
		expect(fetch).toHaveBeenCalledWith(
			'https://drovr-api.wzrrd.sh/parity/transitions',
			expect.objectContaining({
				method: 'POST',
				headers: {
					authorization: 'Bearer shadow-secret',
					'content-type': 'application/json',
				},
				body: JSON.stringify(receipt),
			}),
		)
	})

	it('schedules post-commit work and never fails the caller', async () => {
		const scheduled: Array<() => Promise<void>> = []
		const warn = vi.fn().mockRejectedValue(new Error('logger unavailable'))
		const sink = createDrovrParityReceiptSink({
			config: {
				ingestUrl: 'https://drovr-api.wzrrd.sh/events',
				apiKey: 'shadow-secret',
			},
			fetch: vi.fn().mockRejectedValue(new Error('drovr unavailable')),
			warn,
			schedule: (task) => scheduled.push(task),
		})

		await expect(Effect.runPromise(sink.push(receipt))).resolves.toBeUndefined()
		expect(scheduled).toHaveLength(1)
		await expect(scheduled[0]!()).resolves.toBeUndefined()
		expect(warn).toHaveBeenCalledOnce()
		expect(JSON.stringify(warn.mock.calls)).not.toContain('shadow-secret')
	})

	it('does nothing when the existing shadow configuration is incomplete', async () => {
		const fetch = vi.fn()
		const sink = createDrovrParityReceiptSink({
			config: { ingestUrl: undefined, apiKey: 'shadow-secret' },
			fetch,
			schedule: (task) => void task(),
		})

		await Effect.runPromise(sink.push(receipt))
		expect(fetch).not.toHaveBeenCalled()
	})
})
