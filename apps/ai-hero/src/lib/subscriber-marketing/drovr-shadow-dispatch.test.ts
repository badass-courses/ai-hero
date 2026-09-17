import { describe, expect, it, vi } from 'vitest'

import { dispatchDrovrShadowFact } from './drovr-shadow-dispatch'
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
