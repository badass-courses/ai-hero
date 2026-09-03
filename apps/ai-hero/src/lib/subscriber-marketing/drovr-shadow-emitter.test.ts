import { describe, expect, it, vi } from 'vitest'

import type { ContactEventRecord, SideEffectIntent } from './types'
import {
	emitDrovrShadowFact,
	mapDrovrShadowFact,
} from './drovr-shadow-emitter'

const occurredAt = '2026-08-30T12:00:00.000Z'

function contactEvent(
	eventType: string,
	overrides: Partial<ContactEventRecord> = {},
): ContactEventRecord {
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
			providerIdentity: {
				provider: 'ai-hero',
				externalId: 'contact-1',
			},
		},
		payloadSummary: {
			summary: 'not forwarded',
			keywords: [],
			restrictedPayloadStored: false,
		},
		schemaVersion: 1,
		createdAt: occurredAt,
		...overrides,
	}
}

function completedIntent(
	overrides: Partial<SideEffectIntent> = {},
): SideEffectIntent {
	return {
		id: 'intent-1',
		nextActionId: 'next-action-1',
		contactId: 'contact-1',
		provider: 'kit',
		type: 'send-value-path-email',
		status: 'completed',
		completedAt: occurredAt,
		idempotencyKey: 'source-intent-key',
		gates: [],
		reviewReasons: [],
		metadata: {
			valuePathSlug: 'ai-hero-skills-workflow',
			emailResourceId: 'ai-hero-skills-workflow.email-2',
		},
		createdAt: '2026-08-30T11:00:00.000Z',
		...overrides,
	}
}

describe('drovr shadow fact mapper', () => {
	it('maps a skills newsletter subscription to course contact creation', () => {
		expect(
			mapDrovrShadowFact({
				kind: 'contact-event',
				event: contactEvent('skills-newsletter.subscribed'),
			}),
		).toEqual([
			{
				tenantId: 'org-aihero-shadow',
				contactId: 'contact-1',
				journeyId: 'value-path-skills-course',
				type: 'contact.created',
				occurredAt,
				idempotencyKey: 'aihero:semantic:skills-newsletter.subscribed:1',
			},
		])
	})

	it('maps an answer selection to the email position carried by click progression', () => {
		const event = contactEvent('value-path.answer-selected', {
			payloadSummary: {
				summary: 'not forwarded',
				keywords: [
					'value-path',
					'answer-selected',
					'ai-hero-skills-workflow.email-3',
				],
				restrictedPayloadStored: false,
			},
		})

		expect(mapDrovrShadowFact({ kind: 'contact-event', event })).toEqual([
			{
				tenantId: 'org-aihero-shadow',
				contactId: 'contact-1',
				journeyId: 'value-path-skills-course',
				type: 'value-path.answer-selected',
				occurredAt,
				idempotencyKey: 'aihero:semantic:value-path.answer-selected:1',
				payload: {
					emailResourceId: 'ai-hero-skills-workflow.email-3',
				},
			},
		])
	})

	it('maps a completed email intent with a deterministic intent key', () => {
		const fact = {
			kind: 'side-effect-intent-completed' as const,
			intent: completedIntent(),
		}

		expect(mapDrovrShadowFact(fact)).toEqual([
			{
				tenantId: 'org-aihero-shadow',
				contactId: 'contact-1',
				journeyId: 'value-path-skills-course',
				type: 'email.completed',
				occurredAt,
				idempotencyKey: 'aihero:intent-completed:intent-1',
				payload: {
					emailResourceId: 'ai-hero-skills-workflow.email-2',
				},
			},
		])
		expect(mapDrovrShadowFact(fact)).toEqual(mapDrovrShadowFact(fact))
	})

	it('maps a new durable course completion to both journeys with fallback timezone', () => {
		const events = mapDrovrShadowFact({
			kind: 'course-completed',
			contactId: 'contact-1',
			valuePathSlug: 'ai-hero-skills-workflow',
			completedAt: occurredAt,
		})

		expect(events).toEqual([
			{
				tenantId: 'org-aihero-shadow',
				contactId: 'contact-1',
				journeyId: 'value-path-skills-course',
				type: 'course.sequence-exhausted',
				occurredAt,
				idempotencyKey:
					'aihero:completion:contact-1:ai-hero-skills-workflow',
			},
			{
				tenantId: 'org-aihero-shadow',
				contactId: 'contact-1',
				journeyId: 'crash-course-evergreen-offer',
				type: 'course.sequence-exhausted',
				occurredAt,
				idempotencyKey:
					'aihero:completion:contact-1:ai-hero-skills-workflow',
				payload: {
					valuePathSlug: 'ai-hero-skills-workflow',
					completedAt: occurredAt,
					timezone: 'America/Los_Angeles',
					timezoneSource: 'fallback',
				},
			},
		])
	})

	it('uses only a valid Vercel timezone header for course completion', () => {
		const baseFact = {
			kind: 'course-completed' as const,
			contactId: 'contact-1',
			valuePathSlug: 'ai-hero-skills-workflow',
			completedAt: occurredAt,
		}
		const evergreen = (timezoneHeader?: string) =>
			mapDrovrShadowFact({ ...baseFact, timezoneHeader }).find(
				(event) => event.journeyId === 'crash-course-evergreen-offer',
			)

		expect(evergreen('Asia/Tokyo')?.payload).toMatchObject({
			timezone: 'Asia/Tokyo',
			timezoneSource: 'vercel-header',
		})
		expect(evergreen('not-a-zone')?.payload).toMatchObject({
			timezone: 'America/Los_Angeles',
			timezoneSource: 'fallback',
		})
	})

	it.each(['contact.unsubscribed', 'purchase.recorded'])(
		'forwards %s to both journeys',
		(eventType) => {
			const event = contactEvent(eventType, {
				payloadSummary: {
					summary: 'not forwarded',
					keywords:
						eventType === 'purchase.recorded'
							? ['purchase-recorded', 'product-ai-hero', 'status-valid']
							: ['contact-unsubscribed'],
					restrictedPayloadStored: false,
				},
			})
			const events = mapDrovrShadowFact({ kind: 'contact-event', event })

			expect(events.map(({ journeyId }) => journeyId)).toEqual([
				'value-path-skills-course',
				'crash-course-evergreen-offer',
			])
			if (eventType === 'purchase.recorded') {
				expect(events.map(({ payload }) => payload)).toEqual([
					{ productId: 'product-ai-hero' },
					{ productId: 'product-ai-hero' },
				])
			} else {
				expect(events.every((item) => item.payload === undefined)).toBe(true)
			}
		},
	)

	it('does not put an unsubscribe email into the drovr idempotency key', () => {
		const [event] = mapDrovrShadowFact({
			kind: 'contact-event',
			event: contactEvent('contact.unsubscribed', {
				semanticIdempotencyKey:
					'kit:contact.unsubscribed:learner@example.com:newsletter',
			}),
		})

		expect(event?.idempotencyKey).toBe(
			'aihero:contact-event:contact-event-1',
		)
		expect(JSON.stringify(event)).not.toContain('learner@example.com')
	})

	it('ignores every other source fact', () => {
		expect(
			mapDrovrShadowFact({
				kind: 'contact-event',
				event: contactEvent('content.read'),
			}),
		).toEqual([])
	})
})

describe('drovr shadow sender', () => {
	it('does nothing when either env variable is absent', async () => {
		const fetch = vi.fn()
		const fact = {
			kind: 'contact-event' as const,
			event: contactEvent('skills-newsletter.subscribed'),
		}

		await emitDrovrShadowFact(fact, { fetch })
		await emitDrovrShadowFact(fact, {
			config: { ingestUrl: undefined, apiKey: 'test-key' },
			fetch,
		})
		await emitDrovrShadowFact(fact, {
			config: { ingestUrl: 'https://drovr.test/events', apiKey: undefined },
			fetch,
		})

		expect(fetch).not.toHaveBeenCalled()
	})

	it('posts the ingress contract once with bearer auth', async () => {
		const fetch = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ accepted: true }), {
				status: 202,
				headers: { 'content-type': 'application/json' },
			}),
		)
		const event = contactEvent('skills-newsletter.subscribed')

		await emitDrovrShadowFact(
			{ kind: 'contact-event', event },
			{
				config: {
					ingestUrl: 'https://drovr.test/events',
					apiKey: 'test-key',
				},
				fetch,
			},
		)

		expect(fetch).toHaveBeenCalledTimes(1)
		expect(fetch).toHaveBeenCalledWith(
			'https://drovr.test/events',
			expect.objectContaining({
				method: 'POST',
				headers: {
					authorization: 'Bearer test-key',
					'content-type': 'application/json',
				},
				body: JSON.stringify(
					mapDrovrShadowFact({ kind: 'contact-event', event })[0],
				),
			}),
		)
	})

	it('warns with 4xx problem details and does not retry', async () => {
		const fetch = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					type: 'https://drovr.test/problems/unknown-event',
					title: 'Unknown event',
					steeringHint: 'check the journey event type',
				}),
				{
					status: 422,
					headers: { 'content-type': 'application/problem+json' },
				},
			),
		)
		const warn = vi.fn()

		await emitDrovrShadowFact(
			{
				kind: 'contact-event',
				event: contactEvent('skills-newsletter.subscribed'),
			},
			{
				config: {
					ingestUrl: 'https://drovr.test/events',
					apiKey: 'test-key',
				},
				fetch,
				warn,
			},
		)

		expect(fetch).toHaveBeenCalledTimes(1)
		expect(warn).toHaveBeenCalledTimes(1)
		expect(warn).toHaveBeenCalledWith(
			'drovr.shadow.rejected',
			expect.objectContaining({
				status: 422,
				problem: expect.objectContaining({ title: 'Unknown event' }),
			}),
		)
	})

	it('swallows network failures after one warning and one attempt', async () => {
		const fetch = vi.fn().mockRejectedValue(new Error('network down'))
		const warn = vi.fn()

		await expect(
			emitDrovrShadowFact(
				{
					kind: 'contact-event',
					event: contactEvent('skills-newsletter.subscribed'),
				},
				{
					config: {
						ingestUrl: 'https://drovr.test/events',
						apiKey: 'test-key',
					},
					fetch,
					warn,
				},
			),
		).resolves.toBeUndefined()
		expect(fetch).toHaveBeenCalledTimes(1)
		expect(warn).toHaveBeenCalledTimes(1)
		expect(warn).toHaveBeenCalledWith('drovr.shadow.emit_failed', {
			eventCount: 1,
			error: 'network down',
		})
	})
})
