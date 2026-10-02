import { afterEach, expect, it, vi } from 'vitest'
import { InMemorySubscriberMarketingRepository } from './dry-run'
import { captureNormalizedContactEvent } from './capture-contact-event'
import { normalizeContactEvent } from './normalize-contact-event'
import { ensureShadowNewsletterOwnershipAssignment } from './skills-newsletter-path-entry'
import {
	createOldNewsletterExitGate,
	OldNewsletterExitRefusedError,
	readOldSequenceMembership,
} from './old-newsletter-exit'
import { executePendingEvergreenSends } from './drovr-evergreen-sender'
import { mapDrovrShadowFact } from './drovr-shadow-emitter'
import { replayNewsletterExitReceipt } from './newsletter-exit-replay'
import { toContactEventRecord } from './drizzle-capture-repository'
import { summarizeGateDStatus } from './value-path-gate-d-summary'

const now = '2026-10-03T12:00:00.000Z'
async function fixture() {
	const repository = new InMemorySubscriberMarketingRepository()
	const capture = await captureNormalizedContactEvent({
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
		contactId: capture.contact.id,
		providerIdentityId: capture.providerIdentity.id,
		kitSubscriberId: '123',
		email: 'reader@example.test',
		occurredAt: now,
	}
	const event = (eventType: string) =>
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
			contactId: admission.contactId,
			providerIdentityId: admission.providerIdentityId,
			providerReference: 'kit:sequence:2625552',
		})
	const row = () =>
		repository.createSideEffectIntent({
			id: 'send',
			nextActionId: 'send',
			contactId: admission.contactId,
			provider: 'kit',
			type: 'send-shadow-newsletter-email',
			status: 'pending',
			idempotencyKey: 'send',
			gates: [],
			reviewReasons: [],
			createdAt: now,
			metadata: { kitSequenceId: '2899143', attempts: 0 },
		})
	return { repository, admission, event, row }
}
afterEach(() => {
	vi.unstubAllEnvs()
	vi.unstubAllGlobals()
})

it('desk ruling: a new app-owned signup records bound absence and receives its normal birth and Shadow send', async () => {
	vi.stubEnv('AIH_SHADOW_NEWSLETTER_EXIT_RULE_READY', '')
	const { repository, admission, row } = await fixture()
	expect(
		await ensureShadowNewsletterOwnershipAssignment({
			...admission,
			source: 'drovr-owned-signup',
		}),
	).toMatchObject({ eventType: 'journey.owner.assigned' })
	expect(
		repository.findContactEventsByType(
			admission.contactId,
			'newsletter.old-sequence.absent',
		),
	).toMatchObject([
		{
			contactId: admission.contactId,
			provider: 'kit',
			providerReference: 'kit:sequence:2625552',
			payloadSummary: { source: 'drovr-owned-signup' },
		},
	])
	expect(await readOldSequenceMembership(repository, admission.contactId)).toBe(
		'absent',
	)
	// Keep the existing Stage 3 timing, not an invented early ownership birth.
	expect(
		mapDrovrShadowFact({
			kind: 'course-exhausted',
			timezone: { timezone: 'UTC', timezoneSource: 'fallback' },
			contactId: admission.contactId,
			valuePathSlug: 'ai-hero-skills-workflow',
			completedAt: now,
			exhaustedAt: now,
		}),
	).toContainEqual(
		expect.objectContaining({
			journeyId: 'shadow-newsletter',
			type: 'contact.created',
		}),
	)
	row()
	const subscribe = vi.fn(async () => 'added')
	expect(
		await executePendingEvergreenSends({
			repository,
			subscribe,
			dispatch: () => {},
			type: 'send-shadow-newsletter-email',
			limit: 1,
		}),
	).toMatchObject([{ status: 'completed' }])
	expect(subscribe).toHaveBeenCalledTimes(1)
})

it('absence and admission provenance survive the actual database record decoder', async () => {
	const { repository, admission } = await fixture()
	await ensureShadowNewsletterOwnershipAssignment({
		...admission,
		source: 'drovr-owned-signup',
	})
	for (const fact of repository.contactEvents.values())
		repository.contactEvents.set(fact.id, toContactEventRecord(fact))
	expect(await readOldSequenceMembership(repository, admission.contactId)).toBe(
		'absent',
	)
})

it('legacy enrollment prevents absence, even when a reader returns through signup', async () => {
	const { repository, admission, event } = await fixture()
	event('newsletter.old-sequence.enrollment-requested')
	expect(
		await ensureShadowNewsletterOwnershipAssignment({
			...admission,
			source: 'drovr-owned-signup',
		}),
	).toMatchObject({ eventType: 'newsletter.admission.held' })
	expect(
		repository.findContactEventsByType(
			admission.contactId,
			'newsletter.old-sequence.absent',
		),
	).toHaveLength(0)
})

it('veteran and genuinely unknown admissions cannot infer absence', async () => {
	const { repository, admission } = await fixture()
	expect(
		await ensureShadowNewsletterOwnershipAssignment({
			...admission,
			source: 'newsletter-veteran',
		}),
	).toMatchObject({ eventType: 'newsletter.admission.held' })
	expect(
		await ensureShadowNewsletterOwnershipAssignment({
			...admission,
			source: 'drovr-owned-signup',
		}),
	).toMatchObject({ eventType: 'newsletter.admission.held' })
	expect(
		repository.findContactEventsByType(
			admission.contactId,
			'newsletter.old-sequence.absent',
		),
	).toHaveLength(0)
})

it('a returning veteran signup cannot manufacture absence from missing legacy history', async () => {
	const { repository, admission } = await fixture()
	for (const entry of repository.findContactEventsByType(
		admission.contactId,
		'skills-newsletter.subscribed',
	)) {
		repository.contactEvents.set(entry.id, {
			...entry,
			occurredAt: '2026-09-01T12:00:00.000Z',
		})
	}
	expect(
		await ensureShadowNewsletterOwnershipAssignment({
			...admission,
			source: 'drovr-owned-signup',
		}),
	).toMatchObject({ eventType: 'newsletter.admission.held' })
	expect(
		repository.findContactEventsByType(
			admission.contactId,
			'newsletter.old-sequence.absent',
		),
	).toHaveLength(0)
})

it.each(['429', '503', 'timeout'])(
	'N1 exit-tag %s escapes admission for Inngest retry',
	async (message) => {
		const { repository, admission, event } = await fixture()
		event('newsletter.old-sequence.enrollment-requested')
		const transport = new Error(message)
		const gate = createOldNewsletterExitGate({
			repository,
			endOldSequenceMembership: async () => {
				throw transport
			},
		})
		await expect(
			ensureShadowNewsletterOwnershipAssignment({
				...admission,
				oldNewsletterExit: gate,
			}),
		).rejects.toBe(transport)
		expect(
			repository.findContactEventsByType(
				admission.contactId,
				'newsletter.admission.held',
			),
		).toHaveLength(0)
	},
)

it('N2 membership read unavailability leaves a proven send pending, not exit-held', async () => {
	const { repository, admission, event, row } = await fixture()
	event('newsletter.exit-required')
	event('newsletter.old-sequence.exit-confirmed')
	row()
	const subscribe = vi.fn(async () => 'added')
	await expect(
		executePendingEvergreenSends({
			repository,
			subscribe,
			dispatch: () => {},
			type: 'send-shadow-newsletter-email',
			limit: 1,
			oldNewsletterExit: async () => {
				throw new OldNewsletterExitRefusedError(
					'membership-or-exit-unavailable',
				)
			},
		}),
	).rejects.toThrow('membership-or-exit-unavailable')
	expect(repository.sideEffectIntents.get('send')).toMatchObject({
		status: 'pending',
		metadata: { attempts: 0 },
	})
	expect(subscribe).not.toHaveBeenCalled()
})

it('replayed signup birth retains signup provenance, not veteran provenance', async () => {
	const { repository, admission, event } = await fixture()
	event('newsletter.old-sequence.enrollment-requested')
	await ensureShadowNewsletterOwnershipAssignment({
		...admission,
		source: 'drovr-owned-signup',
	})
	const proof = event('newsletter.old-sequence.exit-confirmed')
	// Independent proof must be strictly newer than enrollment.
	repository.contactEvents.set(proof.id, {
		...proof,
		occurredAt: '2026-10-03T12:01:00.000Z',
	})
	const send = vi.fn(async (_payload: unknown) => undefined)
	expect(
		await replayNewsletterExitReceipt({
			repository,
			contactId: admission.contactId,
			receiptId: proof.id,
			now,
			send,
		}),
	).toMatchObject({ admissions: 1 })
	expect(send.mock.calls[0]?.[0]).toMatchObject({
		data: {
			source: 'drovr-owned-signup',
			events: [
				{ idempotencyKey: `aihero:newsletter-signup:${admission.contactId}` },
			],
		},
	})
})

it('newsletter queue receipts count active and exit-held work separately', async () => {
	const { repository, row } = await fixture()
	row()
	repository.updateSideEffectIntent('send', { status: 'held-for-exit', completedAt: null, gates: [], reviewReasons: ['old-newsletter-exit-unconfirmed'], metadata: {} })
	expect(await repository.findNewsletterSendQueueCounts()).toEqual({
		pending: 0,
		heldForExit: 1,
	})
})

it('held-for-exit remains visible in pending totals and a separate held count', async () => {
	const result = await summarizeGateDStatus({
		contactIds: ['reader'],
		now,
		repository: {
			async *findGateDStatusPages() {
				yield {
					events: [],
					intents: [
						{
							id: 'held',
							contactId: 'reader',
							status: 'held-for-exit',
							createdAt: now,
							metadata: {},
							reviewReasons: ['old-newsletter-exit-unconfirmed'],
						},
					],
				}
			},
		},
	})
	expect(result.totals).toMatchObject({ pending: 1, heldForExit: 1 })
})
