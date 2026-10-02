import { afterEach, describe, expect, it, vi } from 'vitest'
import { InMemorySubscriberMarketingRepository } from './dry-run'
import { normalizeContactEvent } from './normalize-contact-event'
import { captureNormalizedContactEvent } from './capture-contact-event'
import { ensureShadowNewsletterOwnershipAssignment } from './skills-newsletter-path-entry'
import { recordJourneyOwnerAssigned } from './drovr-ownership'
import { executePendingEvergreenSends } from './drovr-evergreen-sender'
import { assignNewsletterVeteransBatch } from './newsletter-veterans'
import { endOldSequenceMembership } from './old-newsletter-exit'

const now = '2026-10-02T12:00:00.000Z'
async function fixture() {
	const repository = new InMemorySubscriberMarketingRepository()
	const captured = await captureNormalizedContactEvent({
		repository,
		event: normalizeContactEvent({
			provider: 'kit',
			externalId: '123',
			email: 'reader@example.test',
			providerEventId: 'signup',
			eventType: 'skills-newsletter.subscribed',
			occurredAt: now,
			message: 'Signup',
			privacyLevel: 'internal',
		}),
	})
	const admission = {
		repository,
		contactId: captured.contact.id,
		providerIdentityId: captured.providerIdentity.id,
		kitSubscriberId: '123',
		email: 'reader@example.test',
		occurredAt: now,
	}
	const event = (eventType: string, contactId = admission.contactId) =>
		repository.createContactEvent({
			...normalizeContactEvent({
				provider: 'kit',
				externalId: '123',
				email: admission.email,
				providerEventId: eventType,
				eventType,
				occurredAt: now,
				message: 'Receipt',
				privacyLevel: 'internal',
			}),
			contactId,
			providerIdentityId: admission.providerIdentityId,
			providerReference: 'kit:sequence:2625552',
		})
	return { repository, admission, event }
}
function row(
	repository: InMemorySubscriberMarketingRepository,
	contactId: string,
	id: string,
	type:
		| 'send-shadow-newsletter-email'
		| 'subscribe-evergreen-list' = 'send-shadow-newsletter-email',
) {
	repository.createSideEffectIntent({
		id,
		contactId,
		nextActionId: id,
		provider: 'kit',
		type,
		status: 'pending',
		idempotencyKey: id,
		gates: [],
		reviewReasons: [],
		createdAt: now,
		metadata: {
			kitSequenceId:
				type === 'subscribe-evergreen-list' ? '2625552' : '2899143',
			list: 'shadow-newsletter',
		},
	})
}
afterEach(() => {
	vi.unstubAllEnvs()
	vi.unstubAllGlobals()
})

describe('Opus newsletter lifecycle regressions', () => {
	it('H1 persists a durable admission hold and returns instead of throwing', async () => {
		vi.stubEnv('AIH_SHADOW_NEWSLETTER_EXIT_RULE_READY', '')
		const { repository, admission } = await fixture()
		await expect(
			ensureShadowNewsletterOwnershipAssignment(admission),
		).resolves.toMatchObject({ eventType: 'newsletter.admission.held' })
		expect(
			repository.findContactEventsByType(
				admission.contactId,
				'newsletter.admission.held',
			),
		).toHaveLength(1)
	})

	it.each([
		'send-shadow-newsletter-email',
		'subscribe-evergreen-list',
	] as const)(
		'H2 more than limit held readers do not starve a proven %s row',
		async (type) => {
			const { repository, admission, event } = await fixture()
			event('newsletter.exit-required')
			for (let i = 0; i < 5; i++)
				row(repository, admission.contactId, `held-${i}`, type)
			const subscribe = vi.fn(async () => 'added')
			const drain = () =>
				executePendingEvergreenSends({
					repository,
					subscribe,
					dispatch: () => {},
					limit: 2,
					type,
					now: () => now,
				})
			await drain()
			await drain()
			await drain()
			const proven = await repository.createContact({
				email: 'proven@example.test',
				name: null,
				lifecycle: 'new',
				isProvisional: false,
				createdAt: now,
				updatedAt: now,
			})
			event('newsletter.exit-required', proven.id)
			event('newsletter.old-sequence.exit-confirmed', proven.id)
			await recordJourneyOwnerAssigned({
				...admission,
				contactId: proven.id,
				journeyId: 'shadow-newsletter',
			})
			row(repository, proven.id, 'proven', type)
			expect(await drain()).toMatchObject([
				{ intentId: 'proven', status: 'completed' },
			])
			expect(subscribe).toHaveBeenCalledTimes(
				type === 'subscribe-evergreen-list' ? 0 : 1,
			)
		},
	)

	it('H3 existing Shadow owners without exit proof still receive Shadow', async () => {
		vi.stubEnv('AIH_SHADOW_NEWSLETTER_EXISTING_EXIT_GATE_ENABLED', '')
		const { repository, admission } = await fixture()
		await recordJourneyOwnerAssigned({
			...admission,
			journeyId: 'shadow-newsletter',
		})
		row(repository, admission.contactId, 'existing')
		const subscribe = vi.fn(async () => 'added')
		expect(
			await executePendingEvergreenSends({
				repository,
				subscribe,
				dispatch: () => {},
				limit: 2,
				type: 'send-shadow-newsletter-email',
			}),
		).toMatchObject([{ status: 'completed' }])
		expect(subscribe).toHaveBeenCalledTimes(1)
	})

	it('a transient scope read failure does not strand an exempt reader in exit-held state', async () => {
		const { repository, admission } = await fixture()
		row(repository, admission.contactId, 'existing-scope-error')
		const read = repository.findContactEventsByType.bind(repository)
		vi.spyOn(repository, 'findContactEventsByType').mockImplementation((contactId, eventType) => {
			if (eventType === 'newsletter.exit-required') throw new Error('scope read failed')
			return read(contactId, eventType)
		})
		await expect(executePendingEvergreenSends({ repository, subscribe: async () => 'added', dispatch: () => {}, limit: 1, type: 'send-shadow-newsletter-email' })).rejects.toThrow('scope read failed')
		expect(repository.sideEffectIntents.get('existing-scope-error')?.status).toBe('pending')
	})

	it('M1 rule-ready alone cannot enable exit tagging before the producer', async () => {
		vi.stubEnv('AIH_SHADOW_NEWSLETTER_EXIT_RULE_READY', 'true')
		vi.stubEnv('AIH_SHADOW_NEWSLETTER_EXIT_PRODUCER_READY', '')
		vi.stubEnv('KIT_SHADOW_NEWSLETTER_EXIT_TAG_ID', '999999')
		vi.stubEnv('KIT_V4_API_KEY', 'fake')
		const fetch = vi.fn(async () => new Response('{}', { status: 201 }))
		vi.stubGlobal('fetch', fetch)
		expect(
			await endOldSequenceMembership({
				contactId: 'reader',
				email: 'reader@example.test',
			}),
		).toBe('unsupported')
		expect(fetch).not.toHaveBeenCalled()
	})

	it('M2 unowned list handoffs retain the prior subscribe/backfill completion', async () => {
		const { repository, admission } = await fixture()
		row(repository, admission.contactId, 'unowned', 'subscribe-evergreen-list')
		const subscribe = vi.fn(async () => 'backfilled')
		expect(
			await executePendingEvergreenSends({
				repository,
				subscribe,
				dispatch: () => {},
				limit: 2,
				type: 'subscribe-evergreen-list',
			}),
		).toMatchObject([{ status: 'completed' }])
		expect(subscribe).toHaveBeenCalledTimes(1)
	})

	it('M4 missing cohort snapshot is not permission to take a veteran', async () => {
		const { repository, admission } = await fixture()
		await recordJourneyOwnerAssigned({
			...admission,
			journeyId: 'value-path-skills-course',
		})
		const exit = vi.fn(async () => {})
		const result = await assignNewsletterVeteransBatch({
			repository,
			batch: [{ contactId: admission.contactId, kitSubscriberId: '123' }],
			dryRun: false,
			now,
			oldNewsletterExit: exit,
		})
		expect(result.counts.cohortUnknown).toBe(1)
		expect(exit).not.toHaveBeenCalled()
	})

	it('M4 protected overlap reader without newsletter ownership is excluded before any tag', async () => {
		const { repository, admission, event } = await fixture()
		await recordJourneyOwnerAssigned({
			...admission,
			journeyId: 'value-path-skills-course',
		})
		event('newsletter.shadow.protected-cohort')
		const exit = vi.fn(async () => {})
		const send = vi.fn(async () => undefined)
		const result = await assignNewsletterVeteransBatch({
			repository,
			batch: [{ contactId: admission.contactId, kitSubscriberId: '123' }],
			dryRun: false,
			now,
			oldNewsletterExit: exit,
			send,
		})
		expect(result.counts.assigned).toBe(0)
		expect(exit).not.toHaveBeenCalled()
		expect(send).not.toHaveBeenCalled()
	})
})
