import { afterEach, describe, expect, it, vi } from 'vitest'
import { ensureShadowNewsletterOwnershipAssignment } from './skills-newsletter-path-entry'
import { assignNewsletterVeteransBatch } from './newsletter-veterans'
import { InMemorySubscriberMarketingRepository } from './dry-run'
import { captureNormalizedContactEvent } from './capture-contact-event'
import { normalizeContactEvent } from './normalize-contact-event'
import { recordJourneyOwnerAssigned } from './drovr-ownership'
import { replayNewsletterExitReceipt } from './newsletter-exit-replay'
import { executePendingEvergreenSends } from './drovr-evergreen-sender'
import {
	createOldNewsletterExitGate,
	endOldSequenceMembership,
	readOldSequenceMembership,
	OLD_NEWSLETTER_EXIT_CONFIRMED,
	OLD_NEWSLETTER_SUBSCRIBED,
	OLD_NEWSLETTER_REFERENCE,
} from './old-newsletter-exit'

const now = '2026-10-02T12:00:00.000Z'
async function reader() {
	const repository = new InMemorySubscriberMarketingRepository()
	const capture = await captureNormalizedContactEvent({
		repository,
		event: normalizeContactEvent({
			provider: 'kit',
			externalId: '123',
			email: 'reader@example.test',
			providerEventId: 'signup-1',
			eventType: 'skills-newsletter.subscribed',
			occurredAt: now,
			message: 'Test signup',
			privacyLevel: 'internal',
		}),
	})
	const admission = {
		repository,
		contactId: capture.contact.id,
		providerIdentityId: capture.providerIdentity.id,
		kitSubscriberId: '123',
		email: 'reader@example.test',
		occurredAt: now,
	}
	const receipt = (
		eventType: string,
		occurredAt = now,
		reference = OLD_NEWSLETTER_REFERENCE,
	) =>
		repository.createContactEvent({
			...normalizeContactEvent({
				provider: 'kit',
				externalId: '123',
				email: admission.email,
				providerEventId: `sequence:2625552:${eventType}:${occurredAt}`,
				eventType,
				occurredAt,
				message: 'Sequence receipt',
				privacyLevel: 'internal',
			}),
			providerReference: reference,
			contactId: admission.contactId,
			providerIdentityId: admission.providerIdentityId,
			createdAt: occurredAt,
		})
	return { repository, admission, receipt }
}

afterEach(() => {
	vi.unstubAllEnvs()
	vi.unstubAllGlobals()
})

describe('newsletter admission requires confirmed legacy exit', () => {
	it('does not birth a new entrant without confirmed legacy exit', async () => {
		vi.stubEnv('AIH_SHADOW_NEWSLETTER_EXIT_RULE_READY', '')
		const { repository, admission } = await reader()
		await expect(
			ensureShadowNewsletterOwnershipAssignment(admission),
		).resolves.toMatchObject({ eventType: 'newsletter.admission.held' })
		expect(
			repository.findContactEventsByType(
				admission.contactId,
				'journey.owner.assigned',
			),
		).toHaveLength(0)
	})

	it('does not birth a veteran without confirmed legacy exit', async () => {
		vi.stubEnv('AIH_SHADOW_NEWSLETTER_EXIT_RULE_READY', '')
		const { repository, admission, receipt } = await reader()
		receipt('newsletter.shadow.cohort-clear')
		await recordJourneyOwnerAssigned({
			...admission,
			journeyId: 'value-path-skills-course',
		})
		const send = vi.fn(async () => undefined)
		await expect(
			assignNewsletterVeteransBatch({
				repository,
				batch: [{ contactId: admission.contactId, kitSubscriberId: '123' }],
				dryRun: false,
				now,
				send,
			}),
		).resolves.toMatchObject({ counts: { held: 1, birthsQueued: 0 } })
		expect(send).not.toHaveBeenCalled()
	})

	it.each(['new entrant', 'veteran'])(
		'refuses a %s Shadow send while legacy exit is unconfirmed',
		async (path) => {
			const { repository, admission, receipt } = await reader()
			if (path === 'veteran') receipt(OLD_NEWSLETTER_SUBSCRIBED)
			receipt('newsletter.exit-required')
			// Only readers newly taken by drovr enter the send gate.
			repository.createSideEffectIntent({
				id: 'send-shadow-1',
				nextActionId: 'drovr:shadow-1',
				contactId: admission.contactId,
				provider: 'kit',
				type: 'send-shadow-newsletter-email',
				status: 'pending',
				idempotencyKey: 'shadow-1',
				gates: [],
				reviewReasons: [],
				createdAt: now,
				metadata: {
					kitSequenceId: '2899143',
					source: 'drovr',
					messageId: 'agents_md_big_problem_v1',
					attempts: 6,
				},
			})
			const subscribe = vi.fn(async () => 'added')
			const dispatch = vi.fn()
			for (let retry = 0; retry < 8; retry++) {
				const results = await executePendingEvergreenSends({
					repository,
					subscribe,
					limit: 1,
					now: () => now,
					dispatch,
					type: 'send-shadow-newsletter-email',
				})
				if (retry === 0)
					expect(results).toMatchObject([
						{ status: 'retry', error: 'old-newsletter-exit-unconfirmed' },
					])
				else expect(results).toEqual([])
			}
			expect(subscribe).not.toHaveBeenCalled()
			expect(dispatch).not.toHaveBeenCalled()
			expect(repository.sideEffectIntents.get('send-shadow-1')).toMatchObject({
				status: 'held-for-exit',
				metadata: { attempts: 6, lastError: 'old-newsletter-exit-unconfirmed' },
			})
		},
	)

	it('confirms from app records, admits once, and repairs a lost veteran birth', async () => {
		const { repository, admission, receipt } = await reader()
		receipt('newsletter.shadow.cohort-clear')
		receipt(OLD_NEWSLETTER_SUBSCRIBED, '2026-10-01T12:00:00.000Z')
		receipt(OLD_NEWSLETTER_EXIT_CONFIRMED)
		const first = await ensureShadowNewsletterOwnershipAssignment(admission)
		expect(await ensureShadowNewsletterOwnershipAssignment(admission)).toEqual(
			first,
		)
		await recordJourneyOwnerAssigned({
			...admission,
			journeyId: 'value-path-skills-course',
		})
		const send = vi.fn(async () => undefined)
		const result = await assignNewsletterVeteransBatch({
			repository,
			batch: [{ contactId: admission.contactId, kitSubscriberId: '123' }],
			dryRun: false,
			now,
			send,
		})
		expect(result.counts.birthsQueued).toBe(1)
		expect(send).toHaveBeenCalledTimes(1)
	})

	it.each([
		'send-shadow-newsletter-email',
		'subscribe-evergreen-list',
	] as const)(
		'holds %s then completes idempotently only after independent exit proof',
		async (type) => {
			const { repository, admission, receipt } = await reader()
			receipt('newsletter.exit-required')
			await recordJourneyOwnerAssigned({
				...admission,
				journeyId: 'shadow-newsletter',
			})
			repository.createSideEffectIntent({
				id: 'held',
				nextActionId: 'drovr:held',
				contactId: admission.contactId,
				provider: 'kit',
				type,
				status: 'pending',
				idempotencyKey: 'held',
				gates: [],
				reviewReasons: [],
				createdAt: now,
				metadata: {
					kitSequenceId:
						type === 'subscribe-evergreen-list' ? '2625552' : '2899143',
					list: 'shadow-newsletter',
				},
			})
			const subscribe = vi.fn(async () => 'added')
			const dispatch = vi.fn()
			const drain = () =>
				executePendingEvergreenSends({
					repository,
					subscribe,
					dispatch,
					type,
					limit: 1,
					now: () => now,
				})
			expect(await drain()).toMatchObject([{ status: 'retry' }])
			expect(subscribe).not.toHaveBeenCalled()
			expect(dispatch).not.toHaveBeenCalled()
			const proof = receipt(OLD_NEWSLETTER_EXIT_CONFIRMED)
			await replayNewsletterExitReceipt({
				repository,
				contactId: admission.contactId,
				receiptId: proof.id,
				now,
				send: async () => undefined,
			})
			expect(await drain()).toMatchObject([{ status: 'completed' }])
			expect(await drain()).toEqual([])
			expect(subscribe).toHaveBeenCalledTimes(
				type === 'subscribe-evergreen-list' ? 0 : 1,
			)
			expect(dispatch).toHaveBeenCalledTimes(1)
		},
	)

	it('checks existing owners without requesting cohort cleanup', async () => {
		const { repository, admission } = await reader()
		await recordJourneyOwnerAssigned({
			...admission,
			journeyId: 'shadow-newsletter',
		})
		const fetch = vi.fn()
		vi.stubGlobal('fetch', fetch)
		vi.stubEnv('AIH_SHADOW_NEWSLETTER_EXIT_RULE_READY', 'true')
		vi.stubEnv('KIT_SHADOW_NEWSLETTER_EXIT_TAG_ID', '999999')
		await expect(
			ensureShadowNewsletterOwnershipAssignment(admission),
		).resolves.toMatchObject({ eventType: 'journey.owner.assigned' })
		expect(fetch).not.toHaveBeenCalled()
	})
})

describe('local membership proof and exit port', () => {
	it('unknown history and tag writes alone never prove exit', async () => {
		const { repository, admission, receipt } = await reader()
		expect(
			await readOldSequenceMembership(repository, admission.contactId),
		).toBe('unknown')
		receipt('newsletter.old-sequence.exit-tag-added')
		const end = vi.fn(async () => 'requested' as const)
		const gate = createOldNewsletterExitGate({
			repository,
			endOldSequenceMembership: end,
		})
		await expect(gate(admission)).rejects.toMatchObject({ retryable: true })
		expect(end).toHaveBeenCalledTimes(1)
	})

	it('requires a sequence-specific receipt newer than any old subscription', async () => {
		const { repository, admission, receipt } = await reader()
		receipt(OLD_NEWSLETTER_EXIT_CONFIRMED, now, 'kit:sequence:2757199')
		expect(
			await readOldSequenceMembership(repository, admission.contactId),
		).toBe('unknown')
		receipt(OLD_NEWSLETTER_EXIT_CONFIRMED, '2026-10-02T12:01:00.000Z')
		receipt(OLD_NEWSLETTER_SUBSCRIBED, '2026-10-02T12:02:00.000Z')
		expect(
			await readOldSequenceMembership(repository, admission.contactId),
		).toBe('present')
	})

	it('distinguishes retryable local read failure from escaping tag transport failure', async () => {
		const { repository, admission } = await reader()
		const gate = createOldNewsletterExitGate({
			repository,
			endOldSequenceMembership: async () => {
				throw new Error('provider failed')
			},
		})
		await expect(gate(admission)).rejects.toThrow('provider failed')
		vi.spyOn(repository, 'findContactEventsByType').mockImplementation(() => {
			throw new Error('db down')
		})
		await expect(gate(admission)).rejects.toMatchObject({ retryable: true })
	})

	it.each(['', '23763332', '22309615', 'invalid'])(
		'does not write Kit for an unapproved/invalid exit tag %s',
		async (tagId) => {
			const fetch = vi.fn()
			vi.stubGlobal('fetch', fetch)
			vi.stubEnv('AIH_SHADOW_NEWSLETTER_EXIT_RULE_READY', 'true')
			vi.stubEnv('KIT_SHADOW_NEWSLETTER_EXIT_TAG_ID', tagId)
			expect(
				await endOldSequenceMembership({
					contactId: 'reader',
					email: 'reader@example.test',
				}),
			).toBe('unsupported')
			expect(fetch).not.toHaveBeenCalled()
		},
	)

	it('requests the new exit tag via the existing client, but still refuses without rule completion proof', async () => {
		const { repository, admission } = await reader()
		const fetch = vi.fn(async () => new Response('{}', { status: 201 }))
		vi.stubGlobal('fetch', fetch)
		vi.stubEnv('KIT_V4_API_KEY', 'fake-test-key')
		vi.stubEnv('AIH_SHADOW_NEWSLETTER_EXIT_PRODUCER_READY', 'true')
		vi.stubEnv('AIH_SHADOW_NEWSLETTER_EXIT_RULE_READY', 'true')
		vi.stubEnv('KIT_SHADOW_NEWSLETTER_EXIT_TAG_ID', '999999')
		await expect(
			createOldNewsletterExitGate({ repository, endOldSequenceMembership })(
				admission,
			),
		).rejects.toMatchObject({ retryable: true })
		expect(fetch).toHaveBeenCalledWith(
			'https://api.kit.com/v4/tags/999999/subscribers',
			expect.objectContaining({ method: 'POST' }),
		)
	})
})
