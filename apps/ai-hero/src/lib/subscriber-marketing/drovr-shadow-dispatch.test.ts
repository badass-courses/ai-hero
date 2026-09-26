import { describe, expect, it, vi } from 'vitest'

import {
	dispatchDrovrShadowFact,
	sendDrovrEventsDeliverViaInngestHttp,
} from './drovr-shadow-dispatch'
import {
	mapDrovrShadowFact,
	type DrovrShadowFact,
} from './drovr-shadow-emitter'
import type { ContactEventRecord } from './types'

const occurredAt = '2026-09-16T12:00:00.000Z'

function contactEvent(eventType: string): ContactEventRecord {
	return {
		id: 'contact-event-1',
		contactId: 'contact-1',
		providerIdentityId: 'identity-1',
		provider: 'ai-hero',
		providerEventId: 'provider-event-1',
		providerReference: 'provider-reference-1',
		eventType,
		occurredAt,
		semanticIdempotencyKey: `semantic:${eventType}:1`,
		privacyLevel: 'internal',
		identityEvidence: {
			source: 'ai-hero',
			strength: 'strong',
			providerIdentity: { provider: 'ai-hero', externalId: 'contact-1' },
		},
		payloadSummary: {
			summary: 'not forwarded',
			keywords: [],
			restrictedPayloadStored: false,
		},
		schemaVersion: 1,
		createdAt: occurredAt,
	}
}

const signup: DrovrShadowFact = {
	kind: 'contact-event',
	event: contactEvent('skills-newsletter.subscribed'),
}

const courseCompleted: DrovrShadowFact = {
	kind: 'course-completed',
	contactId: 'contact-1',
	valuePathSlug: 'ai-hero-skills-workflow',
	completedAt: occurredAt,
}

const courseExhausted: DrovrShadowFact = {
	kind: 'course-exhausted',
	contactId: 'contact-1',
	valuePathSlug: 'ai-hero-skills-workflow',
	completedAt: occurredAt,
	exhaustedAt: '2026-08-31T16:00:00.000Z',
	timezone: {
		timezone: 'Asia/Tokyo',
		timezoneSource: 'vercel-header',
	},
}

describe('drovr shadow dispatch', () => {
	it('queues the mapped events as one durable Inngest batch', async () => {
		const send = vi.fn().mockResolvedValue({ ids: ['evt-1'] })
		const fallback = vi.fn()

		const result = await dispatchDrovrShadowFact(signup, { send, fallback })

		expect(result).toBe('queued')
		expect(send).toHaveBeenCalledTimes(1)
		expect(send).toHaveBeenCalledWith({
			name: 'drovr/events.deliver',
			data: { events: mapDrovrShadowFact(signup), source: 'contact-event' },
		})
		expect(fallback).not.toHaveBeenCalled()
	})

	it.each([
		['a contact event', { ...signup, event: { ...contactEvent('skills-newsletter.subscribed'), contactId: 'synthetic_run-1' } }],
		['a course completion', { ...courseCompleted, contactId: 'synthetic_run-1' }],
	] as const)('never queues, posts or enters evergreen for %s about a synthetic principal', async (_name, fact) => {
		const send = vi.fn()
		const fallback = vi.fn()
		const enterPitch = vi.fn()

		const result = await dispatchDrovrShadowFact(fact as DrovrShadowFact, {
			send,
			fallback,
			enterPitch,
			evergreenEnabled: true,
		})

		expect(result).toBe('nothing')
		expect(send).not.toHaveBeenCalled()
		expect(fallback).not.toHaveBeenCalled()
		expect(enterPitch).not.toHaveBeenCalled()
	})

	it('keys a bulk producer birth to its own delivery lane', async () => {
		const created: DrovrShadowFact = {
			kind: 'contact-created',
			contactId: 'contact-1',
			createdAt: occurredAt,
			sourceLifecycle: 'new',
			kitSubscriberId: '43',
		}
		const send = vi.fn().mockResolvedValue({ ids: ['evt-1'] })

		await dispatchDrovrShadowFact(created, { send })
		await dispatchDrovrShadowFact(
			{ ...created, deliverySource: 'kit-directory-ingest' },
			{ send },
		)

		expect(send.mock.calls.map(([payload]) => payload.data.source)).toEqual([
			'contact-created',
			'kit-directory-ingest',
		])
		// A key on the shared function was not isolation (2026-09-21 04:44Z:
		// live facts waited eleven minutes behind a Kit page); the bulk
		// source travels on its own function.
		expect(send.mock.calls.map(([payload]) => payload.name)).toEqual([
			'drovr/events.deliver',
			'drovr/events.deliver.bulk',
		])
		expect(send.mock.calls[0]?.[0].data.events).toEqual(
			send.mock.calls[1]?.[0].data.events,
		)
	})

	it('posts the exact durable event through Inngest HTTP', async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValue(Response.json({ ids: ['evt-1'], status: 200 }))
		const payload = {
			name: 'drovr/events.deliver' as const,
			data: {
				events: mapDrovrShadowFact(signup),
				source: 'contact-event' as const,
			},
		}

		await expect(
			sendDrovrEventsDeliverViaInngestHttp(payload, {
				eventKey: 'test-key',
				fetchImpl,
			}),
		).resolves.toEqual({ ids: ['evt-1'], status: 200 })

		expect(fetchImpl).toHaveBeenCalledTimes(1)
		const [url, init] = fetchImpl.mock.calls[0] ?? []
		expect(url).toBe('https://inn.gs/e/test-key')
		expect(init).toMatchObject({
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(payload),
		})
	})

	it('rejects a malformed Inngest HTTP acknowledgement', async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValue(Response.json({ ids: [], status: 202 }))

		await expect(
			sendDrovrEventsDeliverViaInngestHttp(
				{
					name: 'drovr/events.deliver',
					data: {
						events: mapDrovrShadowFact(signup),
						source: 'contact-event',
					},
				},
				{ eventKey: 'test-key', fetchImpl },
			),
		).rejects.toThrow('invalid acknowledgement')
	})

	it('falls back to the direct post when queueing fails, after one warning', async () => {
		const send = vi.fn().mockRejectedValue(new Error('inngest unreachable'))
		const fallback = vi.fn().mockResolvedValue(undefined)
		const warn = vi.fn()

		const result = await dispatchDrovrShadowFact(signup, {
			send,
			fallback,
			warn,
			resolveOwners: async () => [],
		})

		expect(result).toBe('fallback')
		expect(warn).toHaveBeenCalledWith('drovr.shadow.queue_failed', {
			source: 'contact-event',
			eventCount: 1,
			error: 'inngest unreachable',
		})
		expect(fallback).toHaveBeenCalledWith(mapDrovrShadowFact(signup))
	})

	it('hands the fact back to the durable path when the fallback cannot read owners', async () => {
		const send = vi
			.fn()
			.mockRejectedValueOnce(new Error('inngest unreachable'))
			.mockResolvedValueOnce(undefined)
		const fallback = vi.fn().mockResolvedValue(undefined)
		const error = vi.fn()
		const unsubscribe: DrovrShadowFact = {
			kind: 'contact-event',
			event: contactEvent('contact.unsubscribed'),
		}

		const result = await dispatchDrovrShadowFact(unsubscribe, {
			send,
			fallback,
			warn: vi.fn(),
			error,
			resolveOwners: async () => {
				throw new Error('Vitess: connection reset')
			},
		})

		// The durable function retries the owner read in its own step.
		expect(result).toBe('requeued')
		expect(send).toHaveBeenCalledTimes(2)
		expect(send.mock.calls[1]).toEqual(send.mock.calls[0])
		expect(fallback).not.toHaveBeenCalled()
		expect(error).toHaveBeenCalledWith(
			'drovr.shadow.fallback_owner_resolve_failed',
			expect.objectContaining({
				source: 'contact-event',
				requeued: true,
				error: 'Vitess: connection reset',
			}),
		)
	})

	it('names the undelivered stop at error when the requeue fails too, and still posts what it can', async () => {
		const send = vi.fn().mockRejectedValue(new Error('inngest unreachable'))
		const fallback = vi.fn().mockResolvedValue(undefined)
		const error = vi.fn()
		const unsubscribe: DrovrShadowFact = {
			kind: 'contact-event',
			event: contactEvent('contact.unsubscribed'),
		}

		const result = await dispatchDrovrShadowFact(unsubscribe, {
			send,
			fallback,
			warn: vi.fn(),
			error,
			resolveOwners: async () => {
				throw new Error('Vitess: connection reset')
			},
		})

		expect(result).toBe('fallback')
		const keys = mapDrovrShadowFact(unsubscribe).map((e) => e.idempotencyKey)
		expect(error).toHaveBeenCalledWith(
			'drovr.shadow.fallback_owner_resolve_failed',
			expect.objectContaining({
				requeued: false,
				idempotencyKeys: keys,
			}),
		)
		// No owner copies (unknown), but the rest still goes out.
		expect(fallback).toHaveBeenCalledWith(mapDrovrShadowFact(unsubscribe))
	})

	it('surfaces a failed direct post at error instead of swallowing it', async () => {
		const send = vi.fn().mockRejectedValue(new Error('inngest unreachable'))
		const fallback = vi.fn().mockRejectedValue(new Error('drovr 503'))
		const error = vi.fn()

		await dispatchDrovrShadowFact(signup, {
			send,
			fallback,
			warn: vi.fn(),
			error,
			resolveOwners: async () => [],
		})

		expect(error).toHaveBeenCalledWith(
			'drovr.shadow.fallback_failed',
			expect.objectContaining({
				source: 'contact-event',
				error: 'drovr 503',
				idempotencyKeys: mapDrovrShadowFact(signup).map(
					(e) => e.idempotencyKey,
				),
			}),
		)
	})

	it("fans an owned contact's fact out to the authority tenant on the fallback road too", async () => {
		const send = vi.fn().mockRejectedValue(new Error('inngest unreachable'))
		const fallback = vi.fn().mockResolvedValue(undefined)
		const unsubscribe: DrovrShadowFact = {
			kind: 'contact-event',
			event: contactEvent('contact.unsubscribed'),
		}

		await dispatchDrovrShadowFact(unsubscribe, {
			send,
			fallback,
			warn: vi.fn(),
			resolveOwners: async () => ['contact-1'],
		})

		const delivered = fallback.mock.calls[0]?.[0] as Array<{
			tenantId: string
			type: string
		}>
		expect(delivered.map((event) => event.tenantId).sort()).toEqual([
			'org-aihero',
			'org-aihero',
			'org-aihero-shadow',
			'org-aihero-shadow',
		])
		expect(
			delivered.every((event) => event.type === 'contact.unsubscribed'),
		).toBe(true)
	})

	it('filters a veteran newsletter birth even when evergreen ownership is present', async () => {
		const send = vi.fn().mockRejectedValue(new Error('inngest unreachable'))
		const fallback = vi.fn().mockResolvedValue(undefined)

		await dispatchDrovrShadowFact(courseCompleted, {
			send,
			fallback,
			warn: vi.fn(),
			evergreenEnabled: false,
			resolveOwners: async () => ['contact-1'],
			resolveNewsletterOwners: async () => [],
		})

		const delivered = fallback.mock.calls[0]?.[0] as Array<{
			journeyId: string
			type: string
		}>
		expect(
			delivered.some(
				(event) =>
					event.journeyId === 'shadow-newsletter' &&
					event.type === 'contact.created',
			),
		).toBe(false)
	})

	it('does not run the forward route or change completion events while the evergreen flag is off', async () => {
		const send = vi.fn().mockResolvedValue({ ids: ['evt-1'] })
		const enterPitch = vi.fn()

		await dispatchDrovrShadowFact(courseCompleted, {
			send,
			enterPitch,
			evergreenEnabled: false,
		})

		expect(enterPitch).not.toHaveBeenCalled()
		expect(send.mock.calls[0]?.[0].data.events).toEqual(
			mapDrovrShadowFact(courseCompleted),
		)
	})

	it('enters an eligible legacy finisher with the real completion time', async () => {
		const send = vi.fn().mockResolvedValue({ ids: ['evt-1'] })
		const enterPitch = vi.fn().mockResolvedValue({
			status: 'entered',
			journeyId: 'crash-course-evergreen-offer',
		})

		await dispatchDrovrShadowFact(courseCompleted, {
			send,
			enterPitch,
			evergreenEnabled: true,
		})

		expect(enterPitch).toHaveBeenCalledWith({
			contactId: 'contact-1',
			completedAt: occurredAt,
		})
		const events = send.mock.calls[0]?.[0].data.events
		expect(events).toHaveLength(3)
		expect(
			events.find(
				(event: { journeyId: string }) =>
					event.journeyId === 'crash-course-evergreen-offer',
			),
		).toMatchObject({
			type: 'course.sequence-exhausted',
			occurredAt,
			idempotencyKey: 'aihero:completion:contact-1:ai-hero-skills-workflow',
		})
	})

	it('keeps an already drovr-owned eligible finisher on the existing completion route', async () => {
		const send = vi.fn().mockResolvedValue({ ids: ['evt-1'] })
		await dispatchDrovrShadowFact(courseCompleted, {
			send,
			evergreenEnabled: true,
			enterPitch: vi.fn().mockResolvedValue({
				status: 'already-entered',
				journeyId: 'crash-course-evergreen-offer',
			}),
		})
		expect(send.mock.calls[0]?.[0].data.events).toEqual(
			mapDrovrShadowFact(courseCompleted),
		)
	})

	it('fails closed and removes the evergreen exhaustion for a live purchaser', async () => {
		const send = vi.fn().mockResolvedValue({ ids: ['evt-1'] })
		const warn = vi.fn()
		await dispatchDrovrShadowFact(courseCompleted, {
			send,
			warn,
			evergreenEnabled: true,
			enterPitch: vi.fn().mockResolvedValue({
				status: 'refused',
				reason: 'crash-course-purchaser',
			}),
		})
		const events = send.mock.calls[0]?.[0].data.events
		expect(events).toHaveLength(2)
		expect(events[0]).toMatchObject({
			journeyId: 'value-path-skills-course',
			type: 'course.sequence-exhausted',
		})
		expect(
			events.some(
				(event: { journeyId: string }) =>
					event.journeyId === 'crash-course-evergreen-offer',
			),
		).toBe(false)
		expect(warn).toHaveBeenCalledWith('drovr.evergreen.entry_refused', {
			contactId: 'contact-1',
			reason: 'crash-course-purchaser',
		})
	})

	it('fails closed for an ineligible course exhaustion without evergreen or newsletter birth', async () => {
		const send = vi.fn().mockResolvedValue({ ids: ['evt-1'] })
		const warn = vi.fn()

		await dispatchDrovrShadowFact(courseExhausted, {
			send,
			warn,
			evergreenEnabled: true,
			enterPitch: vi.fn().mockResolvedValue({
				status: 'refused',
				reason: 'unsubscribed',
			}),
		})

		const events = send.mock.calls[0]?.[0].data.events
		expect(events).toHaveLength(1)
		expect(events[0]).toMatchObject({
			journeyId: 'value-path-skills-course',
			type: 'course.sequence-exhausted',
		})
		expect(
			events.some(
				(event: { journeyId: string }) =>
					event.journeyId === 'crash-course-evergreen-offer',
			),
		).toBe(false)
		expect(
			events.some(
				(event: { journeyId: string }) =>
					event.journeyId === 'shadow-newsletter',
			),
		).toBe(false)
		expect(warn).toHaveBeenCalledWith('drovr.evergreen.entry_refused', {
			contactId: 'contact-1',
			reason: 'unsubscribed',
		})
	})

	it('logs an unsubscribe refusal but never labels entry errors as refusals', async () => {
		const send = vi.fn().mockResolvedValue({ ids: ['evt-1'] })
		const unsubscribedWarn = vi.fn()
		await dispatchDrovrShadowFact(courseCompleted, {
			send,
			warn: unsubscribedWarn,
			evergreenEnabled: true,
			enterPitch: vi.fn().mockResolvedValue({
				status: 'refused',
				reason: 'unsubscribed',
			}),
		})
		expect(unsubscribedWarn).toHaveBeenCalledWith(
			'drovr.evergreen.entry_refused',
			{ contactId: 'contact-1', reason: 'unsubscribed' },
		)

		const failedWarn = vi.fn()
		await dispatchDrovrShadowFact(courseCompleted, {
			send,
			warn: failedWarn,
			evergreenEnabled: true,
			enterPitch: vi.fn().mockRejectedValue(new Error('database unavailable')),
		})
		expect(failedWarn).toHaveBeenCalledWith(
			'drovr.evergreen.entry_failed_closed',
			{ contactId: 'contact-1', error: 'database unavailable' },
		)
		expect(failedWarn).not.toHaveBeenCalledWith(
			'drovr.evergreen.entry_refused',
			expect.anything(),
		)
	})

	it('does nothing for a fact that maps to no drovr event', async () => {
		const send = vi.fn()
		const result = await dispatchDrovrShadowFact(
			{ kind: 'contact-event', event: contactEvent('something.else') },
			{ send },
		)
		expect(result).toBe('nothing')
		expect(send).not.toHaveBeenCalled()
	})
})
