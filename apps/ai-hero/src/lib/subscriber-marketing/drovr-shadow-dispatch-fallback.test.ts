import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ direct: vi.fn(), capture: vi.fn() }))

vi.mock('./drovr-shadow-emitter', async (importOriginal) => ({
	...(await importOriginal<typeof import('./drovr-shadow-emitter')>()),
	deliverDrovrShadowEventsDirect: mocks.direct,
}))
vi.mock('./drovr-outbox-live', () => ({
	captureDrovrOutboxLive: mocks.capture,
}))

import { dispatchDrovrShadowFact } from './drovr-shadow-dispatch'
import {
	mapDrovrShadowFact,
	type DrovrShadowFact,
} from './drovr-shadow-emitter'

const signup: DrovrShadowFact = {
	kind: 'contact-event',
	event: {
		id: 'contact-event-1',
		contactId: 'contact-1',
		providerIdentityId: 'identity-1',
		provider: 'ai-hero',
		providerEventId: 'provider-event-1',
		providerReference: 'provider-reference-1',
		eventType: 'skills-newsletter.subscribed',
		occurredAt: '2026-09-26T05:00:00.000Z',
		semanticIdempotencyKey: 'semantic:skills-newsletter.subscribed:1',
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
		createdAt: '2026-09-26T05:00:00.000Z',
	} as never,
}

describe('the production fallback post (row 204)', () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it('posts directly and outboxes what drovr answered 5xx for', async () => {
		const events = mapDrovrShadowFact(signup)
		mocks.direct.mockResolvedValue(events)
		mocks.capture.mockResolvedValue({ status: 'outboxed', count: 1 })
		const error = vi.fn()

		const result = await dispatchDrovrShadowFact(signup, {
			send: vi.fn().mockRejectedValue(new Error('inngest unreachable')),
			warn: vi.fn(),
			error,
			resolveOwners: async () => [],
		})

		expect(result).toBe('fallback')
		expect(mocks.direct).toHaveBeenCalledWith(events)
		expect(mocks.capture).toHaveBeenCalledWith(
			events.map((event) =>
				expect.objectContaining({
					endpoint: 'events',
					idempotencyKey: event.idempotencyKey,
					body: event,
					source: 'fallback',
					needsFanOut: false,
				}),
			),
			expect.any(Error),
		)
		expect(error).not.toHaveBeenCalledWith(
			'drovr.shadow.fallback_failed',
			expect.anything(),
		)
	})

	it('reports a failed direct post at error with its replay keys when there is no outbox yet', async () => {
		mocks.direct.mockRejectedValue(new Error('drovr 503'))
		mocks.capture.mockResolvedValue({ status: 'unavailable' })
		const error = vi.fn()

		const result = await dispatchDrovrShadowFact(signup, {
			send: vi.fn().mockRejectedValue(new Error('inngest unreachable')),
			warn: vi.fn(),
			error,
			resolveOwners: async () => [],
		})

		expect(result).toBe('fallback')
		expect(error).toHaveBeenCalledWith(
			'drovr.shadow.fallback_failed',
			expect.objectContaining({
				error: 'drovr 503',
				idempotencyKeys: mapDrovrShadowFact(signup).map(
					(event) => event.idempotencyKey,
				),
			}),
		)
	})
})
