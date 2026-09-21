import { describe, expect, it, vi } from 'vitest'

import {
	batchIngestUrl,
	batchStepId,
	deliverBatchOrThrow,
	deliverOrThrow,
	deliveryStepId,
	DrovrBatchDeliveryFailedError,
	DrovrDeliveryFailedError,
} from './drovr-shadow-delivery'
import type { DrovrShadowEvent } from './drovr-shadow-emitter'

const event: DrovrShadowEvent = {
	tenantId: 'org-aihero-shadow',
	contactId: 'contact-1',
	journeyId: 'value-path-skills-course',
	type: 'contact.created',
	occurredAt: '2026-09-16T12:00:00.000Z',
	idempotencyKey: 'aihero:semantic:skills-newsletter.subscribed:1',
}

const config = { ingestUrl: 'https://drovr.test/events', apiKey: 'test-key' }

describe('drovr durable delivery step', () => {
	it('returns accepted on 200 and posts the event with bearer auth', async () => {
		const fetcher = vi
			.fn()
			.mockResolvedValue(
				new Response(JSON.stringify({ appended: true }), { status: 200 }),
			)

		const outcome = await deliverOrThrow({ event, config, fetcher })

		expect(outcome).toEqual({ status: 'accepted' })
		expect(fetcher).toHaveBeenCalledWith(
			'https://drovr.test/events',
			expect.objectContaining({
				method: 'POST',
				headers: {
					authorization: 'Bearer test-key',
					'content-type': 'application/json',
				},
				body: JSON.stringify(event),
			}),
		)
	})

	it('treats a 4xx problem as final: warns once, does not throw', async () => {
		const fetcher = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ title: 'Unknown journey' }), {
				status: 404,
				headers: { 'content-type': 'application/problem+json' },
			}),
		)
		const warn = vi.fn()

		const outcome = await deliverOrThrow({ event, config, fetcher, warn })

		expect(outcome.status).toBe('rejected')
		expect(warn).toHaveBeenCalledWith(
			'drovr.shadow.rejected',
			expect.objectContaining({
				status: 404,
				idempotencyKey: event.idempotencyKey,
				problem: expect.objectContaining({ title: 'Unknown journey' }),
			}),
		)
	})

	it('throws on a 5xx so the step retries', async () => {
		const fetcher = vi
			.fn()
			.mockResolvedValue(new Response('upstream sad', { status: 503 }))

		await expect(deliverOrThrow({ event, config, fetcher })).rejects.toThrow(
			DrovrDeliveryFailedError,
		)
	})

	it('throws on a network failure so the step retries', async () => {
		const fetcher = vi.fn().mockRejectedValue(new Error('network down'))

		await expect(
			deliverOrThrow({ event, config, fetcher }),
		).rejects.toMatchObject({
			name: 'DrovrDeliveryFailedError',
			idempotencyKey: event.idempotencyKey,
			reason: 'network down',
		})
	})
})

describe('drovr delivery step ids', () => {
	it('gives each journey its own step even when the idempotency key is shared', () => {
		const purchase = { ...event, type: 'purchase.recorded' as const }
		const evergreen: DrovrShadowEvent = {
			...purchase,
			journeyId: 'crash-course-evergreen-offer',
		}
		expect(deliveryStepId(purchase)).not.toBe(deliveryStepId(evergreen))
		expect(deliveryStepId(purchase)).toBe(
			`deliver:value-path-skills-course:${event.idempotencyKey}`,
		)
	})
})

describe('drovr 4xx body handling', () => {
	it('keeps a rejection final and truncates a huge problem body', async () => {
		const huge = JSON.stringify({ title: 'x'.repeat(200_000) })
		const fetcher = vi
			.fn()
			.mockResolvedValue(new Response(huge, { status: 422 }))
		const warn = vi.fn()

		const outcome = await deliverOrThrow({ event, config, fetcher, warn })

		expect(outcome.status).toBe('rejected')
		const problem = warn.mock.calls[0]?.[1]?.problem
		expect(typeof problem).toBe('string')
		expect((problem as string).length).toBeLessThanOrEqual(4096)
	})

	it('keeps a rejection final when the body stream fails', async () => {
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				controller.error(new Error('stream broke'))
			},
		})
		const fetcher = vi
			.fn()
			.mockResolvedValue(new Response(body, { status: 404 }))

		const outcome = await deliverOrThrow({
			event,
			config,
			fetcher,
			warn: vi.fn(),
		})

		expect(outcome).toMatchObject({
			status: 'rejected',
			httpStatus: 404,
			problem: null,
		})
	})
})

describe('drovr batch delivery step', () => {
	const second: DrovrShadowEvent = {
		...event,
		contactId: 'contact-2',
		idempotencyKey: 'aihero:semantic:skills-newsletter.subscribed:2',
	}
	const batchBody = (
		results: { index: number; status: string; detail?: string }[],
	) =>
		JSON.stringify({
			accepted: results.filter((r) => r.status === 'accepted').length,
			rejected: results.filter((r) => r.status === 'rejected').length,
			failed: results.filter((r) => r.status === 'failed').length,
			results,
		})

	it('posts the chunk to /events/batch and returns the counts', async () => {
		const fetcher = vi.fn().mockResolvedValue(
			new Response(
				batchBody([
					{ index: 0, status: 'accepted' },
					{ index: 1, status: 'accepted' },
				]),
				{ status: 200 },
			),
		)

		const outcome = await deliverBatchOrThrow({
			events: [event, second],
			config,
			fetcher,
		})

		expect(outcome).toEqual({ accepted: 2, rejected: 0 })
		expect(fetcher).toHaveBeenCalledWith(
			'https://drovr.test/events/batch',
			expect.objectContaining({
				method: 'POST',
				headers: {
					authorization: 'Bearer test-key',
					'content-type': 'application/json',
				},
				body: JSON.stringify({ events: [event, second] }),
			}),
		)
	})

	it('throws naming the failed keys when drovr could not take an item', async () => {
		const fetcher = vi.fn().mockResolvedValue(
			new Response(
				batchBody([
					{ index: 0, status: 'accepted' },
					{ index: 1, status: 'failed', detail: 'actor busy' },
				]),
				{ status: 200 },
			),
		)

		await expect(
			deliverBatchOrThrow({ events: [event, second], config, fetcher }),
		).rejects.toMatchObject({
			name: 'DrovrBatchDeliveryFailedError',
			failedKeys: [second.idempotencyKey],
		})
	})

	it('warns once per rejected item and does not throw', async () => {
		const fetcher = vi.fn().mockResolvedValue(
			new Response(
				batchBody([
					{ index: 0, status: 'rejected', detail: 'unknown journey nope' },
					{ index: 1, status: 'accepted' },
				]),
				{ status: 200 },
			),
		)
		const warn = vi.fn()

		const outcome = await deliverBatchOrThrow({
			events: [event, second],
			config,
			fetcher,
			warn,
		})

		expect(outcome).toEqual({ accepted: 1, rejected: 1 })
		expect(warn).toHaveBeenCalledTimes(1)
		expect(warn).toHaveBeenCalledWith(
			'drovr.shadow.rejected',
			expect.objectContaining({
				idempotencyKey: event.idempotencyKey,
				problem: 'unknown journey nope',
			}),
		)
	})

	it('treats a 4xx envelope as final for the chunk and a 5xx as a retry', async () => {
		const warn = vi.fn()
		const unauthorized = vi
			.fn()
			.mockResolvedValue(
				new Response(JSON.stringify({ title: 'Unknown key' }), { status: 401 }),
			)
		expect(
			await deliverBatchOrThrow({
				events: [event, second],
				config,
				fetcher: unauthorized,
				warn,
			}),
		).toEqual({ accepted: 0, rejected: 2 })
		expect(warn).toHaveBeenCalledWith(
			'drovr.shadow.batch_rejected',
			expect.objectContaining({ status: 401, count: 2 }),
		)

		const sad = vi
			.fn()
			.mockResolvedValue(new Response('upstream sad', { status: 503 }))
		await expect(
			deliverBatchOrThrow({ events: [event], config, fetcher: sad }),
		).rejects.toThrow(DrovrBatchDeliveryFailedError)

		// A drovr without the batch route yet is a retry, never a drop.
		const missing = vi
			.fn()
			.mockResolvedValue(new Response('not found', { status: 404 }))
		await expect(
			deliverBatchOrThrow({ events: [event], config, fetcher: missing }),
		).rejects.toThrow(/no batch ingress/)
	})

	it('derives the batch url and a stable step id', () => {
		expect(batchIngestUrl('https://drovr.test/events/')).toBe(
			'https://drovr.test/events/batch',
		)
		expect(batchStepId('org-aihero', 3)).toBe('deliver-batch:org-aihero:3')
	})
})
