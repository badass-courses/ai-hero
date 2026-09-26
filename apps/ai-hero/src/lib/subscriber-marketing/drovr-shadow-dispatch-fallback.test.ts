import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ emit: vi.fn() }))

vi.mock('./drovr-shadow-emitter', async (importOriginal) => ({
	...(await importOriginal<typeof import('./drovr-shadow-emitter')>()),
	emitDrovrShadowEvents: mocks.emit,
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

describe('the production fallback post', () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it('asks the emitter to rethrow, so a failed direct post is reported at error with its replay keys', async () => {
		mocks.emit.mockRejectedValue(new Error('drovr 503'))
		const error = vi.fn()

		const result = await dispatchDrovrShadowFact(signup, {
			send: vi.fn().mockRejectedValue(new Error('inngest unreachable')),
			warn: vi.fn(),
			error,
			resolveOwners: async () => [],
		})

		expect(result).toBe('fallback')
		expect(mocks.emit).toHaveBeenCalledWith(mapDrovrShadowFact(signup), {
			rethrow: true,
		})
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
