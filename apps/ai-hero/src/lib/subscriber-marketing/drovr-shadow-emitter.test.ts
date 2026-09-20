import { describe, expect, it, vi } from 'vitest'

import type { ContactEventRecord, SideEffectIntent } from './types'
import { emitDrovrShadowFact, mapDrovrShadowFact } from './drovr-shadow-emitter'

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

	it('routes a drovr-owned completed intent to its owner tenant and mirrors it to the shadow', () => {
		const events = mapDrovrShadowFact({
			kind: 'side-effect-intent-completed',
			intent: completedIntent({
				metadata: {
					source: 'drovr',
					drovr: {
						tenantId: 'org-aihero',
						journeyId: 'value-path-skills-course',
						intentKey:
							'intent:org-aihero:contact-1:value-path-skills-course:email2.pending:drip.email1To2:0',
						dueAt: occurredAt,
					},
					valuePathSlug: 'ai-hero-skills-workflow',
					emailResourceId: 'ai-hero-skills-workflow.email-2',
				},
			}),
		})
		expect(events).toEqual([
			{
				tenantId: 'org-aihero',
				contactId: 'contact-1',
				journeyId: 'value-path-skills-course',
				type: 'email.completed',
				occurredAt,
				idempotencyKey:
					'completion:intent:org-aihero:contact-1:value-path-skills-course:email2.pending:drip.email1To2:0',
				payload: { emailResourceId: 'ai-hero-skills-workflow.email-2' },
			},
			{
				tenantId: 'org-aihero-shadow',
				contactId: 'contact-1',
				journeyId: 'value-path-skills-course',
				type: 'email.completed',
				occurredAt,
				idempotencyKey: 'aihero:intent-completed:intent-1',
				payload: { emailResourceId: 'ai-hero-skills-workflow.email-2' },
			},
		])
	})

	it.each([
		'value-path-skills-course',
		'crash-course-evergreen-offer',
	] as const)(
		'maps a %s journey.owner.assigned event to only that authority birth',
		(journeyId) => {
			const providerEventId = `drovr-owner:contact-1:${journeyId}`
			const semanticIdempotencyKey = `kit:journey.owner.assigned:kit-1:${providerEventId}`
			const events = mapDrovrShadowFact({
				kind: 'contact-event',
				event: contactEvent('journey.owner.assigned', {
					providerEventId,
					semanticIdempotencyKey,
				}),
			})
			expect(events).toEqual([
				{
					tenantId: 'org-aihero',
					contactId: 'contact-1',
					journeyId,
					type: 'contact.created',
					occurredAt,
					idempotencyKey: `aihero:${semanticIdempotencyKey}`,
				},
			])
		},
	)

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
				idempotencyKey: 'aihero:completion:contact-1:ai-hero-skills-workflow',
			},
			{
				tenantId: 'org-aihero-shadow',
				contactId: 'contact-1',
				journeyId: 'crash-course-evergreen-offer',
				type: 'course.sequence-exhausted',
				occurredAt,
				idempotencyKey: 'aihero:completion:contact-1:ai-hero-skills-workflow',
				payload: {
					valuePathSlug: 'ai-hero-skills-workflow',
					completedAt: occurredAt,
					timezone: 'America/Los_Angeles',
					timezoneSource: 'fallback',
				},
			},
			{
				tenantId: 'org-aihero-shadow',
				contactId: 'contact-1',
				journeyId: 'shadow-newsletter',
				type: 'contact.created',
				occurredAt,
				idempotencyKey:
					'contact:org-aihero-shadow:contact-1:shadow-newsletter:birth',
				payload: {
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

	it('maps a live course exhaustion to all three handoff events with its pinned zone', () => {
		const events = mapDrovrShadowFact({
			kind: 'course-exhausted',
			contactId: 'contact-1',
			valuePathSlug: 'ai-hero-skills-workflow',
			completedAt: '2026-08-30T12:00:00.000Z',
			exhaustedAt: '2026-08-31T16:00:00.000Z',
			timezone: {
				timezone: 'Asia/Tokyo',
				timezoneSource: 'vercel-header',
			},
		})

		expect(events).toEqual([
			expect.objectContaining({
				journeyId: 'value-path-skills-course',
				type: 'course.sequence-exhausted',
				occurredAt: '2026-08-31T16:00:00.000Z',
			}),
			expect.objectContaining({
				journeyId: 'crash-course-evergreen-offer',
				type: 'course.sequence-exhausted',
				occurredAt: '2026-08-31T16:00:00.000Z',
				payload: {
					valuePathSlug: 'ai-hero-skills-workflow',
					completedAt: '2026-08-30T12:00:00.000Z',
					timezone: 'Asia/Tokyo',
					timezoneSource: 'vercel-header',
				},
			}),
			expect.objectContaining({
				journeyId: 'shadow-newsletter',
				type: 'contact.created',
				occurredAt: '2026-08-31T16:00:00.000Z',
				payload: {
					timezone: 'Asia/Tokyo',
					timezoneSource: 'vercel-header',
				},
			}),
		])
	})

	it('carries validated purchase timezone evidence into the newsletter birth', () => {
		const event = contactEvent('purchase.recorded', {
			payloadSummary: {
				summary: 'purchase',
				keywords: ['purchase-recorded', 'product-ai-hero'],
				restrictedPayloadStored: false,
			},
			domainPayload: {
				deadlineTimeZone: {
					type: 'BrowserEntryHeader',
					timeZone: 'America/New_York',
				},
			},
		})
		const events = mapDrovrShadowFact({ kind: 'contact-event', event })

		expect(events[2]?.payload).toEqual({
			timezone: 'America/New_York',
			timezoneSource: 'vercel-header',
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

			expect(events.map(({ journeyId }) => journeyId)).toEqual(
				eventType === 'purchase.recorded'
					? [
							'value-path-skills-course',
							'crash-course-evergreen-offer',
							'shadow-newsletter',
						]
					: ['value-path-skills-course', 'crash-course-evergreen-offer'],
			)
			if (eventType === 'purchase.recorded') {
				expect(events[0]?.payload).toEqual({ productId: 'product-ai-hero' })
				expect(events[1]?.payload).toEqual({ productId: 'product-ai-hero' })
				expect(events[2]?.payload).toEqual({
					timezone: 'America/Los_Angeles',
					timezoneSource: 'fallback',
				})
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

		expect(event?.idempotencyKey).toBe('aihero:contact-event:contact-event-1')
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

describe('drovr direct sender: per-tenant keys', () => {
	it('posts an authority-owned completion with the authority key, not the shadow key', async () => {
		const fetch = vi
			.fn()
			.mockImplementation(() =>
				Promise.resolve(new Response('{}', { status: 200 })),
			)
		await emitDrovrShadowFact(
			{
				kind: 'side-effect-intent-completed',
				intent: completedIntent({
					metadata: {
						source: 'drovr',
						drovr: {
							tenantId: 'org-aihero',
							journeyId: 'value-path-skills-course',
							intentKey: 'k',
							dueAt: occurredAt,
						},
						valuePathSlug: 'ai-hero-skills-workflow',
						emailResourceId: 'ai-hero-skills-workflow.email-2',
					},
				}),
			},
			{
				config: {
					ingestUrl: 'https://drovr.test/events',
					apiKey: 'shadow-key',
					authorityApiKey: 'authority-key',
				},
				fetch,
			},
		)
		// Owner completion plus the shadow mirror, each with its tenant's key.
		expect(fetch).toHaveBeenCalledTimes(2)
		const keys = fetch.mock.calls.map(
			(call) =>
				(call[1] as { headers: Record<string, string> }).headers.authorization,
		)
		expect(keys.sort()).toEqual(['Bearer authority-key', 'Bearer shadow-key'])
	})

	it('warns and skips an authority event when no authority key is configured', async () => {
		const fetch = vi.fn()
		const warn = vi.fn()
		await emitDrovrShadowFact(
			{
				kind: 'side-effect-intent-completed',
				intent: completedIntent({
					metadata: {
						drovr: {
							tenantId: 'org-aihero',
							journeyId: 'value-path-skills-course',
							intentKey: 'k',
							dueAt: occurredAt,
						},
						emailResourceId: 'ai-hero-skills-workflow.email-2',
					},
				}),
			},
			{
				config: {
					ingestUrl: 'https://drovr.test/events',
					apiKey: 'shadow-key',
				},
				fetch,
				warn,
			},
		)
		// The shadow mirror still posts with the shadow key; only the
		// authority-addressed completion is skipped.
		expect(fetch).toHaveBeenCalledTimes(1)
		expect(fetch.mock.calls[0]?.[1]).toMatchObject({
			headers: expect.objectContaining({ authorization: 'Bearer shadow-key' }),
		})
		expect(warn).toHaveBeenCalledWith(
			'drovr.shadow.tenant_key_missing',
			expect.objectContaining({ tenantId: 'org-aihero' }),
		)
	})
})

describe('evergreen send completions', () => {
	it('completes to the owning evergreen actor only, carrying the message id', () => {
		const events = mapDrovrShadowFact({
			kind: 'side-effect-intent-completed',
			intent: {
				id: 'row-1',
				nextActionId: 'drovr:abc',
				contactId: 'contact-1',
				provider: 'kit',
				type: 'send-evergreen-email',
				status: 'completed',
				completedAt: '2026-09-17T16:00:00.000Z',
				idempotencyKey: 'contact:contact-1:evergreen:bridge_can_engineer_v1',
				gates: [],
				reviewReasons: [],
				metadata: {
					source: 'drovr',
					messageId: 'bridge_can_engineer_v1',
					slot: 'B1',
					kitSequenceId: '2887679',
					drovr: {
						tenantId: 'org-aihero',
						journeyId: 'crash-course-evergreen-offer',
						intentKey: 'k1',
					},
				},
				createdAt: '2026-09-17T15:59:00.000Z',
			},
		})
		expect(events).toEqual([
			{
				tenantId: 'org-aihero',
				contactId: 'contact-1',
				journeyId: 'crash-course-evergreen-offer',
				type: 'email.completed',
				occurredAt: '2026-09-17T16:00:00.000Z',
				idempotencyKey: 'completion:k1',
				payload: { messageId: 'bridge_can_engineer_v1' },
			},
		])
	})
})

describe('shadow-newsletter completions', () => {
	it('completes to the shadow-newsletter actor with the catalog message id', () => {
		const events = mapDrovrShadowFact({
			kind: 'side-effect-intent-completed',
			intent: {
				id: 'row-shadow',
				nextActionId: 'drovr:abc',
				contactId: 'contact-1',
				provider: 'kit',
				type: 'send-shadow-newsletter-email',
				status: 'completed',
				completedAt: '2026-09-26T18:00:00.000Z',
				idempotencyKey:
					'contact:contact-1:shadow-newsletter:agents_md_big_problem_v1',
				gates: [],
				reviewReasons: [],
				metadata: {
					source: 'drovr',
					newsletter: 'shadow-newsletter',
					catalogRevision: 'kit-2625552-2026-09-19',
					messageId: 'agents_md_big_problem_v1',
					position: 0,
					kitSequenceId: '2899143',
					drovr: {
						tenantId: 'org-aihero-shadow',
						journeyId: 'shadow-newsletter',
						intentKey: 'k-shadow',
					},
				},
				createdAt: '2026-09-26T17:59:00.000Z',
			},
		})
		expect(events).toEqual([
			{
				tenantId: 'org-aihero-shadow',
				contactId: 'contact-1',
				journeyId: 'shadow-newsletter',
				type: 'email.completed',
				occurredAt: '2026-09-26T18:00:00.000Z',
				idempotencyKey: 'completion:k-shadow',
				payload: { messageId: 'agents_md_big_problem_v1' },
			},
		])
	})
})

describe('evergreen coupon completions', () => {
	it('completes to the owning evergreen actor as coupon.issued with the coupon id and expiry', () => {
		const events = mapDrovrShadowFact({
			kind: 'side-effect-intent-completed',
			intent: {
				id: 'row-1',
				nextActionId: 'drovr:abc',
				contactId: 'contact-1',
				provider: 'kit',
				type: 'issue-evergreen-coupon',
				status: 'completed',
				completedAt: '2026-09-10T16:00:05.000Z',
				idempotencyKey: 'contact:contact-1:evergreen:coupon',
				gates: [],
				reviewReasons: [],
				metadata: {
					source: 'drovr',
					couponId: 'eoj-coupon:abc',
					expiresAt: '2026-09-15T06:59:59.000Z',
					drovr: {
						tenantId: 'org-aihero',
						journeyId: 'crash-course-evergreen-offer',
						intentKey: 'k-coupon',
					},
				},
				createdAt: '2026-09-10T16:00:01.000Z',
			},
		})
		expect(events).toEqual([
			{
				tenantId: 'org-aihero',
				contactId: 'contact-1',
				journeyId: 'crash-course-evergreen-offer',
				type: 'coupon.issued',
				occurredAt: '2026-09-10T16:00:05.000Z',
				idempotencyKey: 'completion:k-coupon',
				payload: {
					couponId: 'eoj-coupon:abc',
					expiresAt: '2026-09-15T06:59:59.000Z',
				},
			},
		])
	})
})

describe('evergreen list handoff completions', () => {
	it('completes the shadow-newsletter handoff to the owning actor as shadow.entered', () => {
		const events = mapDrovrShadowFact({
			kind: 'side-effect-intent-completed',
			intent: {
				id: 'row-1',
				nextActionId: 'drovr:abc',
				contactId: 'contact-1',
				provider: 'kit',
				type: 'subscribe-evergreen-list',
				status: 'completed',
				completedAt: '2026-09-22T16:00:05.000Z',
				idempotencyKey: 'contact:contact-1:evergreen:list:shadow-newsletter',
				gates: [],
				reviewReasons: [],
				metadata: {
					source: 'drovr',
					list: 'shadow-newsletter',
					kitSequenceId: '2625552',
					timezone: 'America/New_York',
					timezoneSource: 'vercel-header',
					drovr: {
						tenantId: 'org-aihero',
						journeyId: 'crash-course-evergreen-offer',
						intentKey: 'k-list',
					},
				},
				createdAt: '2026-09-22T16:00:01.000Z',
			},
		})
		expect(events).toEqual([
			{
				tenantId: 'org-aihero',
				contactId: 'contact-1',
				journeyId: 'crash-course-evergreen-offer',
				type: 'shadow.entered',
				occurredAt: '2026-09-22T16:00:05.000Z',
				idempotencyKey: 'completion:k-list',
				payload: { list: 'shadow-newsletter' },
			},
			{
				tenantId: 'org-aihero-shadow',
				contactId: 'contact-1',
				journeyId: 'shadow-newsletter',
				type: 'contact.created',
				occurredAt: '2026-09-22T16:00:05.000Z',
				idempotencyKey:
					'contact:org-aihero-shadow:contact-1:shadow-newsletter:birth',
				payload: {
					timezone: 'America/New_York',
					timezoneSource: 'vercel-header',
				},
			},
		])
	})
})
