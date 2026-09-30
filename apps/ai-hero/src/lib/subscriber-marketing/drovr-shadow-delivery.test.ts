import { afterEach, describe, expect, it, vi } from 'vitest'

import {
	batchIngestUrl,
	batchStepId,
	deliverBatchOrThrow,
	deliverOrThrow,
	deliveryStepId,
	DrovrBatchDeliveryFailedError,
	DrovrDeliveryFailedError,
	isNeverBornOwnerStop,
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

/**
 * The event is a value-path birth, which the send clamps to 5 minutes before
 * now (row 201g): pin the clock to its instant so the posted body is the
 * event as built.
 */
const atTheBirth = () => {
	vi.useFakeTimers({ toFake: ['Date'] })
	vi.setSystemTime(new Date(event.occurredAt))
}

afterEach(() => {
	vi.useRealTimers()
})

describe('drovr durable delivery step', () => {
	it('returns accepted on 200 and posts the event with bearer auth', async () => {
		atTheBirth()
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
		atTheBirth()
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

		expect(outcome).toMatchObject({
			accepted: 1,
			rejected: 1,
			refused: [expect.objectContaining({ problem: expect.anything() })],
		})
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
		).toMatchObject({
			accepted: 0,
			rejected: 2,
			refused: [
				expect.objectContaining({ httpStatus: 401 }),
				expect.objectContaining({ httpStatus: 401 }),
			],
		})
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

	it('retries when the body does not cover every submitted event', async () => {
		// Macroscope on #263: a 200 with fewer, duplicate, or unknown results
		// is not a verdict on the chunk. Never let an unrepresented event
		// count as delivered.
		const short = vi.fn().mockResolvedValue(
			new Response(batchBody([{ index: 0, status: 'accepted' }]), {
				status: 200,
			}),
		)
		await expect(
			deliverBatchOrThrow({ events: [event, second], config, fetcher: short }),
		).rejects.toThrow(/1 result\(s\) for 2 event\(s\)/)

		const duplicate = vi.fn().mockResolvedValue(
			new Response(
				batchBody([
					{ index: 0, status: 'accepted' },
					{ index: 0, status: 'accepted' },
				]),
				{ status: 200 },
			),
		)
		await expect(
			deliverBatchOrThrow({
				events: [event, second],
				config,
				fetcher: duplicate,
			}),
		).rejects.toThrow(DrovrBatchDeliveryFailedError)
	})

	it('derives the batch url and a stable step id', () => {
		expect(batchIngestUrl('https://drovr.test/events/')).toBe(
			'https://drovr.test/events/batch',
		)
		expect(batchStepId('org-aihero', 3)).toBe('deliver-batch:org-aihero:3')
	})
})

/**
 * drovr (#346): a directory actor still on v1 answers 409 event-not-live for
 * a contact-sync event instead of accepting and ignoring it. Nothing is
 * saved and the key is not consumed, so the only right answer is to retry
 * later: dropping it would lose the profile for good.
 */
describe('drovr event-not-live (409) is a retry, never a drop', () => {
	const profileEvent: DrovrShadowEvent = {
		tenantId: 'org-aihero',
		contactId: 'contact-1',
		journeyId: 'contact-directory',
		type: 'contact.profile.updated',
		occurredAt: '2026-09-26T17:00:00.000Z',
		idempotencyKey: 'profile:contact-1:4',
		payload: {
			profileVersion: 4,
			email: 'learner@example.test',
			firstName: 'Ada',
			holds: [],
		},
	}
	const notLive = () =>
		new Response(
			JSON.stringify({
				type: 'https://drovr.dev/problems/event-not-live',
				title: 'Event type not live for this actor',
				status: 409,
				detail: 'contact-directory v1 does not take contact.profile.updated',
			}),
			{
				status: 409,
				headers: {
					'content-type': 'application/problem+json',
					'retry-after': '60',
				},
			},
		)

	it('throws on one event so the step retries with backoff, and never warns it rejected', async () => {
		const warn = vi.fn()
		await expect(
			deliverOrThrow({
				event: profileEvent,
				config,
				fetcher: vi.fn().mockResolvedValue(notLive()),
				warn,
			}),
		).rejects.toMatchObject({
			name: 'DrovrDeliveryFailedError',
			idempotencyKey: profileEvent.idempotencyKey,
		})
		expect(warn).not.toHaveBeenCalledWith(
			'drovr.shadow.rejected',
			expect.anything(),
		)
	})

	it('keeps any other 409 final, as before', async () => {
		const conflict = new Response(
			JSON.stringify({ type: 'https://drovr.dev/problems/key-reused' }),
			{ status: 409 },
		)
		const outcome = await deliverOrThrow({
			event: profileEvent,
			config,
			fetcher: vi.fn().mockResolvedValue(conflict),
			warn: vi.fn(),
		})
		expect(outcome.status).toBe('rejected')
	})

	it('retries a batch whose envelope answers event-not-live', async () => {
		const warn = vi.fn()
		await expect(
			deliverBatchOrThrow({
				events: [profileEvent],
				config,
				fetcher: vi.fn().mockResolvedValue(notLive()),
				warn,
			}),
		).rejects.toMatchObject({
			name: 'DrovrBatchDeliveryFailedError',
			failedKeys: [profileEvent.idempotencyKey],
		})
		expect(warn).not.toHaveBeenCalledWith(
			'drovr.shadow.batch_rejected',
			expect.anything(),
		)
	})

	it('retries a batch item drovr rejects as event-not-live, keeping the rest', async () => {
		const other = { ...profileEvent, idempotencyKey: 'profile:contact-2:1' }
		const fetcher = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					accepted: 1,
					rejected: 1,
					failed: 0,
					results: [
						{ index: 0, status: 'accepted' },
						{ index: 1, status: 'rejected', detail: 'event-not-live' },
					],
				}),
				{ status: 200 },
			),
		)
		await expect(
			deliverBatchOrThrow({ events: [profileEvent, other], config, fetcher }),
		).rejects.toMatchObject({
			name: 'DrovrBatchDeliveryFailedError',
			failedKeys: [other.idempotencyKey],
		})
	})
})

/**
 * The contact-sync push contract (§4): a refusal as event-not-live (or
 * cold-start-unhandled) records nothing and leaves the key unconsumed, so
 * the same event is retried unchanged after drovr's daily straggler pass.
 * In `deferNotLive` mode the batch hands those events back instead of
 * throwing, so the caller can schedule that retry; anything else keeps its
 * meaning.
 */
describe('contact sync deferral of refusals (deferNotLive)', () => {
	const profile = (contactId: string): DrovrShadowEvent => ({
		tenantId: 'org-aihero',
		contactId,
		journeyId: 'contact-directory',
		type: 'contact.profile.updated',
		occurredAt: '2026-09-26T17:00:00.000Z',
		idempotencyKey: `profile:${contactId}:1`,
		payload: {
			profileVersion: 1,
			email: 'a@example.test',
			firstName: null,
			holds: [],
		},
	})
	const [one, two, three] = [profile('c1'), profile('c2'), profile('c3')]
	const answer = (
		results: { index: number; status: string; detail?: string }[],
	) =>
		vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					accepted: results.filter((r) => r.status === 'accepted').length,
					rejected: results.filter((r) => r.status === 'rejected').length,
					failed: results.filter((r) => r.status === 'failed').length,
					results,
				}),
				{ status: 200 },
			),
		)

	it('hands back items refused as event-not-live or cold-start-unhandled, unchanged', async () => {
		const warn = vi.fn()
		const outcome = await deliverBatchOrThrow({
			events: [one, two, three],
			config,
			fetcher: answer([
				{ index: 0, status: 'accepted' },
				{ index: 1, status: 'failed', detail: 'event-not-live: v1 actor' },
				{
					index: 2,
					status: 'failed',
					detail: 'cold-start-unhandled: no actor',
				},
			]),
			warn,
			deferNotLive: true,
		})
		expect(outcome).toEqual({
			accepted: 1,
			rejected: 0,
			deferred: [
				{ event: two, reason: 'event-not-live' },
				{ event: three, reason: 'cold-start-unhandled' },
			],
		})
		// No actor at all is an anomaly (the contract expects one): logged.
		expect(warn).toHaveBeenCalledWith(
			'drovr.contact_sync.cold_start_unhandled',
			expect.objectContaining({ idempotencyKey: three.idempotencyKey }),
		)
	})

	it('hands back the whole batch when the envelope answers 409 event-not-live', async () => {
		const fetcher = vi
			.fn()
			.mockResolvedValue(
				new Response(
					JSON.stringify({ type: 'urn:drovr:problem:event-not-live' }),
					{ status: 409 },
				),
			)
		expect(
			await deliverBatchOrThrow({
				events: [one, two],
				config,
				fetcher,
				warn: vi.fn(),
				deferNotLive: true,
			}),
		).toEqual({
			accepted: 0,
			rejected: 0,
			deferred: [
				{ event: one, reason: 'event-not-live' },
				{ event: two, reason: 'event-not-live' },
			],
		})
	})

	it('still throws for any other failed item, and keeps a rejection final', async () => {
		await expect(
			deliverBatchOrThrow({
				events: [one, two],
				config,
				fetcher: answer([
					{ index: 0, status: 'failed', detail: 'event-not-live: v1 actor' },
					{ index: 1, status: 'failed', detail: 'actor busy' },
				]),
				deferNotLive: true,
			}),
		).rejects.toMatchObject({
			name: 'DrovrBatchDeliveryFailedError',
			failedKeys: [two.idempotencyKey],
		})
		expect(
			await deliverBatchOrThrow({
				events: [one],
				config,
				fetcher: answer([
					{ index: 0, status: 'rejected', detail: 'bad shape' },
				]),
				warn: vi.fn(),
				deferNotLive: true,
			}),
		).toMatchObject({ accepted: 0, rejected: 1, refused: [expect.anything()] })
	})
})

/**
 * mig-10 (2026-09-27): a directory stop for a contact with no directory
 * actor answers 409 cold-start-unhandled ("rejected" in a batch), but drovr
 * writes the suppression row before folding, so the stop's effect landed.
 * Counting it as rejected would stall the reconcile, which throws on any
 * rejection.
 */
describe('a directory stop answered cold-start-unhandled is done', () => {
	const stop = (type: 'contact.unsubscribed' | 'contact.complained') => ({
		tenantId: 'org-aihero' as const,
		contactId: 'c9',
		journeyId: 'contact-directory' as const,
		type,
		occurredAt: '2026-09-27T13:00:00.000Z',
		idempotencyKey: `aihero:semantic:${type}:9`,
	})
	const profile: DrovrShadowEvent = {
		tenantId: 'org-aihero',
		contactId: 'c9',
		journeyId: 'contact-directory',
		type: 'contact.profile.updated',
		occurredAt: '2026-09-27T13:00:00.000Z',
		idempotencyKey: 'profile:c9:1',
	}
	const answer = (
		results: { index: number; status: string; detail?: string }[],
	) =>
		vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					accepted: results.filter((r) => r.status === 'accepted').length,
					rejected: results.filter((r) => r.status === 'rejected').length,
					failed: results.filter((r) => r.status === 'failed').length,
					results,
				}),
				{ status: 200 },
			),
		)
	const coldStart = {
		status: 'rejected',
		detail: 'cold-start-unhandled: no directory actor',
	}

	it('counts it as accepted in the default mode (the live lane and the reconcile)', async () => {
		const warn = vi.fn()
		expect(
			await deliverBatchOrThrow({
				events: [stop('contact.unsubscribed'), stop('contact.complained')],
				config,
				fetcher: answer([
					{ index: 0, ...coldStart },
					{ index: 1, ...coldStart },
				]),
				warn,
			}),
		).toEqual({ accepted: 2, rejected: 0 })
		expect(warn).not.toHaveBeenCalledWith(
			'drovr.shadow.rejected',
			expect.anything(),
		)
	})

	it('counts it as accepted in deferNotLive mode too: no birth, no retry needed', async () => {
		expect(
			await deliverBatchOrThrow({
				events: [stop('contact.unsubscribed')],
				config,
				fetcher: answer([{ index: 0, ...coldStart }]),
				warn: vi.fn(),
				deferNotLive: true,
			}),
		).toEqual({ accepted: 1, rejected: 0 })
	})

	it('keeps any other event answered cold-start-unhandled as before', async () => {
		expect(
			await deliverBatchOrThrow({
				events: [profile],
				config,
				fetcher: answer([{ index: 0, ...coldStart }]),
				warn: vi.fn(),
			}),
		).toMatchObject({ accepted: 0, rejected: 1, refused: [expect.anything()] })
	})
})

describe('an owner-copy stop drovr says never started its journey', () => {
	// 2026-09-27: swg6e's unsubscribes were copied to value-path-skills-course,
	// where it has no actor. drovr's 409 wedged the reconcile for two runs.
	const ownerStop = (
		type: DrovrShadowEvent['type'] = 'contact.unsubscribed',
	): DrovrShadowEvent => ({
		tenantId: 'org-aihero',
		contactId: 'swg6e',
		journeyId: 'value-path-skills-course',
		type,
		occurredAt: '2026-09-27T13:47:16.000Z',
		idempotencyKey: 'owner:aihero:contact-event:qp7rf',
	})
	const directoryStop: DrovrShadowEvent = {
		tenantId: 'org-aihero',
		contactId: 'swg6e',
		journeyId: 'contact-directory',
		type: 'contact.unsubscribed',
		occurredAt: '2026-09-27T13:47:16.000Z',
		idempotencyKey: 'aihero:contact-event:qp7rf',
	}
	const neverBorn = {
		status: 'rejected' as const,
		httpStatus: 409,
		problem: {
			type: 'urn:drovr:problem:contact-never-born',
			title: 'Contact never started this journey',
			status: 409,
		},
	}

	it('is recognised for each stop type', () => {
		for (const type of [
			'contact.unsubscribed',
			'contact.bounced',
			'contact.complained',
		] as const) {
			expect(isNeverBornOwnerStop(ownerStop(type), neverBorn)).toBe(true)
		}
	})

	it('never covers a directory stop: that is the suppression authority', () => {
		expect(isNeverBornOwnerStop(directoryStop, neverBorn)).toBe(false)
	})

	it('never covers a non-stop owner copy', () => {
		expect(
			isNeverBornOwnerStop(ownerStop('value-path.answer-selected'), neverBorn),
		).toBe(false)
	})

	it('needs the contact-never-born problem exactly: the typed problem decides, as it does for a batch item', () => {
		expect(
			isNeverBornOwnerStop(ownerStop(), {
				...neverBorn,
				problem: { type: 'urn:drovr:problem:event-not-live' },
			}),
		).toBe(false)
		expect(
			isNeverBornOwnerStop(ownerStop(), {
				...neverBorn,
				problem: { type: 'urn:drovr:problem:contact-not-found' },
			}),
		).toBe(false)
		expect(isNeverBornOwnerStop(ownerStop(), { status: 'accepted' })).toBe(
			false,
		)
	})
})
