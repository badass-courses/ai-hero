import { afterEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ send: vi.fn(async () => ({ ids: ['x'] })) }))
vi.mock('@/inngest/inngest.server', () => ({
	inngest: { send: mocks.send },
}))

import { captureNormalizedContactEvent } from './capture-contact-event'
import { executePendingEvergreenSends } from './drovr-evergreen-sender'
import { DROVR_EVERGREEN_OFFER_JOURNEY_ID } from './drovr-shadow-emitter'
import { InMemorySubscriberMarketingRepository } from './dry-run'
import { normalizeContactEvent } from './normalize-contact-event'
import {
	OLD_NEWSLETTER_REFERENCE,
	OLD_NEWSLETTER_SUBSCRIBED,
} from './old-newsletter-exit'
import { runPurchaseHandoffExitPass } from './purchase-handoff-exit'
import { ensureShadowNewsletterOwnershipAssignment } from './skills-newsletter-path-entry'

afterEach(() => {
	vi.unstubAllEnvs()
})

// The cron calls the pass with no `send`; replay must fall back to the real
// Inngest sender, as the newsletter-exit-replay function relies on.
it('admits through the real default sender when the cron passes no send', async () => {
	vi.stubEnv('AIH_SHADOW_NEWSLETTER_EXIT_RULE_READY', '')
	const at = '2026-10-01T12:00:00.000Z'
	const email = 'reader@example.test'
	const repository = new InMemorySubscriberMarketingRepository()
	const capture = await captureNormalizedContactEvent({
		repository,
		event: normalizeContactEvent({
			provider: 'kit',
			externalId: '123',
			email,
			providerEventId: 'signup',
			eventType: 'skills-newsletter.subscribed',
			occurredAt: at,
			message: 'Signup',
			privacyLevel: 'internal',
		}),
	})
	const contactId = capture.contact.id
	for (const eventType of [OLD_NEWSLETTER_SUBSCRIBED, 'newsletter.exit-required'])
		repository.createContactEvent({
			...normalizeContactEvent({
				provider: 'kit',
				externalId: '123',
				email,
				providerEventId: eventType,
				eventType,
				occurredAt: at,
				message: 'Fixture',
				privacyLevel: 'internal',
			}),
			providerReference: OLD_NEWSLETTER_REFERENCE,
			contactId,
			providerIdentityId: capture.providerIdentity.id,
			createdAt: at,
		})
	await ensureShadowNewsletterOwnershipAssignment({
		repository,
		contactId,
		providerIdentityId: capture.providerIdentity.id,
		kitSubscriberId: '123',
		email,
		occurredAt: at,
	})
	repository.createSideEffectIntent({
		id: 'h',
		nextActionId: 'drovr:h',
		contactId,
		provider: 'kit',
		type: 'subscribe-evergreen-list',
		status: 'pending',
		idempotencyKey: 'h',
		gates: [],
		reviewReasons: [],
		createdAt: at,
		metadata: {
			source: 'drovr',
			drovr: { journeyId: DROVR_EVERGREEN_OFFER_JOURNEY_ID },
			kitSequenceId: 'legacy-sequence',
			list: 'shadow-newsletter',
		},
	})
	await executePendingEvergreenSends({
		repository,
		subscribe: vi.fn(),
		dispatch: vi.fn(),
		type: 'subscribe-evergreen-list',
		limit: 5,
		now: () => at,
	})
	const result = await runPurchaseHandoffExitPass({
		repository,
		isEnabled: async () => true,
		findCrashCoursePurchaseStatuses: async (emails) =>
			new Map(emails.map((e) => [e, ['Valid']])),
		now: '2026-10-02T12:00:00.000Z',
	})
	expect(result).toMatchObject({ results: [{ outcome: 'admitted' }] })
	expect(mocks.send).toHaveBeenCalledTimes(1)
	expect(mocks.send).toHaveBeenCalledWith(
		expect.objectContaining({
			name: expect.stringContaining('drovr'),
			id: expect.stringContaining(`newsletter-exit-replay:${contactId}:`),
		}),
	)
})
