import { afterEach, expect, it, vi } from 'vitest'
import { InMemorySubscriberMarketingRepository } from '@/lib/subscriber-marketing/dry-run'
import { captureNormalizedContactEvent } from '@/lib/subscriber-marketing/capture-contact-event'
import { normalizeContactEvent } from '@/lib/subscriber-marketing/normalize-contact-event'

const mocks = vi.hoisted(() => ({
	repository: undefined as InMemorySubscriberMarketingRepository | undefined,
	enter: vi.fn(),
	subscribe: vi.fn(),
	send: vi.fn(async () => undefined),
	log: { info: vi.fn(), warn: vi.fn() },
}))
vi.mock('@/db', () => ({ db: {} }))
vi.mock('@/inngest/inngest.server', () => ({
	inngest: {
		send: mocks.send,
		createFunction: (config: unknown, trigger: unknown, handler: unknown) => ({
			config,
			trigger,
			handler,
		}),
	},
}))
vi.mock('@/coursebuilder/email-list-provider', () => ({
	emailListProvider: { subscribeToList: mocks.subscribe },
	subscribeToKitListWithoutFields: mocks.subscribe,
	KitSubscribeError: class extends Error {},
}))
vi.mock('@/lib/subscriber-marketing/drizzle-capture-repository', () => ({
	DrizzleCaptureMarketingRepository: vi.fn(function () {
		return mocks.repository
	}),
}))
// Keep the real ownership/hold implementation. Only course entry is outside this test.
vi.mock(
	'@/lib/subscriber-marketing/skills-newsletter-path-entry',
	async (original) => ({
		...(await original<
			typeof import('@/lib/subscriber-marketing/skills-newsletter-path-entry')
		>()),
		enterSkillsNewsletterSubscriber: mocks.enter,
	}),
)
vi.mock('@/lib/subscriber-marketing/email-course-shadow-runtime', () => ({
	createEmailCourseShadowRuntime: () => ({ observeSignup: vi.fn() }),
}))
vi.mock('@/lib/subscriber-marketing/value-path-gate-d-allowlist', () => ({
	readActiveGateDRuntimeAllowlist: async () => ({
		passed: true,
		allowlist: { authorizationMode: 'rolling-public-enrollment' },
	}),
}))
vi.mock('@/server/logger', () => ({ log: mocks.log }))
vi.mock('@/server/redis-client', () => ({ redis: {} }))
import { skillsNewsletterPathEntry } from './skills-newsletter-path-entry'
import { newsletterExitReplay } from './newsletter-exit-replay'
import { ensureShadowNewsletterOwnershipAssignment } from '@/lib/subscriber-marketing/skills-newsletter-path-entry'

afterEach(() => {
	vi.unstubAllEnvs()
})
it('H1 the Inngest refused branch returns with a durable hold, using real assignment code', async () => {
	vi.stubEnv('AIH_SHADOW_NEWSLETTER_EXIT_RULE_READY', '')
	const repository = new InMemorySubscriberMarketingRepository()
	mocks.repository = repository
	const data = {
		kitSubscriberId: '123',
		email: 'reader@example.test',
		formId: 9376133,
		source: 'test',
		subscribedAt: '2026-10-02T12:00:00.000Z',
	}
	const capture = await captureNormalizedContactEvent({
		repository,
		event: normalizeContactEvent({
			provider: 'kit',
			externalId: '123',
			email: data.email,
			providerEventId: 'signup',
			eventType: 'skills-newsletter.subscribed',
			occurredAt: data.subscribedAt,
			message: 'Signup',
			privacyLevel: 'internal',
		}),
	})
	repository.createContactEvent({
		...normalizeContactEvent({
			provider: 'kit',
			externalId: '123',
			email: data.email,
			providerEventId: 'legacy-enrollment',
			eventType: 'newsletter.old-sequence.enrollment-requested',
			occurredAt: data.subscribedAt,
			message: 'Legacy enrollment',
			privacyLevel: 'internal',
		}),
		contactId: capture.contact.id,
		providerIdentityId: capture.providerIdentity.id,
		providerReference: 'kit:sequence:2625552',
	})
	mocks.enter.mockResolvedValue({
		status: 'drovr-owned',
		contactId: capture.contact.id,
		captureEventId: capture.contactEvent.id,
		entry: {
			counts: { planned: 0, blocked: 0, idempotentNoop: 0 },
			results: [],
		},
	})
	const fn = skillsNewsletterPathEntry as unknown as {
		handler: (args: {
			event: { id: string; data: typeof data }
			attempt: number
			maxAttempts: number
			step: {
				run: (id: string, callback: () => Promise<unknown>) => Promise<unknown>
			}
		}) => Promise<unknown>
	}
	await expect(
		fn.handler({
			event: { id: 'signup', data },
			attempt: 0,
			maxAttempts: 7,
			step: { run: async (_id, callback) => callback() },
		}),
	).resolves.toMatchObject({ status: 'drovr-owned', newsletter: 'held' })
	expect(
		repository.findContactEventsByType(
			capture.contact.id,
			'newsletter.admission.held',
		),
	).toHaveLength(1)
	expect(
		repository.findContactEventsByType(
			capture.contact.id,
			'journey.owner.assigned',
		),
	).toHaveLength(0)
	expect(mocks.subscribe).not.toHaveBeenCalled()
})

it('the receipt Inngest function verifies proof, resumes the held admission and re-arms sends once', async () => {
	vi.stubEnv('AIH_SHADOW_NEWSLETTER_EXIT_RULE_READY', '')
	mocks.send.mockClear()
	const repository = new InMemorySubscriberMarketingRepository()
	mocks.repository = repository
	const now = '2026-10-02T12:00:00.000Z'
	const capture = await captureNormalizedContactEvent({
		repository,
		event: normalizeContactEvent({
			provider: 'kit',
			externalId: '123',
			email: 'reader@example.test',
			providerEventId: 'signup-replay',
			eventType: 'skills-newsletter.subscribed',
			occurredAt: now,
			message: 'Signup',
			privacyLevel: 'internal',
		}),
	})
	const contactId = capture.contact.id
	await ensureShadowNewsletterOwnershipAssignment({
		repository,
		contactId,
		providerIdentityId: capture.providerIdentity.id,
		kitSubscriberId: '123',
		email: 'reader@example.test',
		occurredAt: now,
	})
	repository.createSideEffectIntent({
		id: 'held',
		nextActionId: 'held',
		contactId,
		provider: 'kit',
		type: 'send-shadow-newsletter-email',
		status: 'held-for-exit',
		idempotencyKey: 'held',
		gates: [],
		reviewReasons: ['old-newsletter-exit-unconfirmed'],
		createdAt: now,
		metadata: {
			kitSequenceId: '2899143',
			attempts: 0,
			exitHeldAt: now,
			lastError: 'old-newsletter-exit-unconfirmed',
		},
	})
	const fn = newsletterExitReplay as unknown as {
		handler: (args: {
			event: { data: { contactId: string; receiptId: string } }
			step: {
				run: (id: string, callback: () => Promise<unknown>) => Promise<unknown>
			}
		}) => Promise<unknown>
	}
	const run = (receiptId: string) =>
		fn.handler({
			event: { data: { contactId, receiptId } },
			step: { run: async (_id, callback) => callback() },
		})
	expect(await run('tag-ack-not-proof')).toMatchObject({ status: 'unproven' })
	expect(mocks.send).not.toHaveBeenCalled()
	const proof = repository.createContactEvent({
		...normalizeContactEvent({
			provider: 'kit',
			externalId: '123',
			email: 'reader@example.test',
			providerEventId: 'exit-proof',
			eventType: 'newsletter.old-sequence.exit-confirmed',
			occurredAt: now,
			message: 'Verified sequence exit',
			privacyLevel: 'internal',
		}),
		contactId,
		providerIdentityId: capture.providerIdentity.id,
		providerReference: 'kit:sequence:2625552',
	})
	expect(await run(proof.id)).toMatchObject({
		status: 'resumed',
		admissions: 1,
		rearmed: 1,
	})
	expect(repository.sideEffectIntents.get('held')).toMatchObject({
		status: 'pending',
	})
	expect(
		repository.findContactEventsByType(contactId, 'journey.owner.assigned'),
	).toHaveLength(1)
	expect(mocks.send).toHaveBeenCalledTimes(1)
	expect(await run(proof.id)).toMatchObject({ admissions: 0, rearmed: 0 })
	expect(mocks.send).toHaveBeenCalledTimes(1)
	// A provider/app re-enrollment invalidates the previously valid receipt.
	repository.createContactEvent({
		...normalizeContactEvent({
			provider: 'kit',
			externalId: '123',
			email: 'reader@example.test',
			providerEventId: 'new-enrollment',
			eventType: 'newsletter.old-sequence.subscribed',
			occurredAt: '2026-10-02T12:01:00.000Z',
			message: 'Re-enrollment',
			privacyLevel: 'internal',
		}),
		contactId,
		providerIdentityId: capture.providerIdentity.id,
		providerReference: 'kit:sequence:2625552',
	})
	expect(await run(proof.id)).toMatchObject({ status: 'unproven' })
	expect(mocks.send).toHaveBeenCalledTimes(1)
})
