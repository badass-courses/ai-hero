import { afterEach, describe, expect, it, vi } from 'vitest'

import { captureNormalizedContactEvent } from './capture-contact-event'
import { executePendingEvergreenSends } from './drovr-evergreen-sender'
import { InMemorySubscriberMarketingRepository } from './dry-run'
import { normalizeContactEvent } from './normalize-contact-event'
import {
	OLD_NEWSLETTER_EXIT_CONFIRMED,
	OLD_NEWSLETTER_REFERENCE,
	OLD_NEWSLETTER_SUBSCRIBED,
	readOldSequenceMembership,
} from './old-newsletter-exit'
import { runPurchaseHandoffExitPass } from './purchase-handoff-exit'
import { ensureShadowNewsletterOwnershipAssignment } from './skills-newsletter-path-entry'

const signedUpAt = '2026-10-01T12:00:00.000Z'
const now = '2026-10-02T12:00:00.000Z'
const email = 'reader@example.test'

afterEach(() => {
	vi.unstubAllEnvs()
})

/** A reader still in the old sequence, held by the admission gate, whose
 * drovr evergreen handoff row sits in held-for-exit. */
async function heldHandoff() {
	vi.stubEnv('AIH_SHADOW_NEWSLETTER_EXIT_RULE_READY', '')
	const repository = new InMemorySubscriberMarketingRepository()
	const capture = await captureNormalizedContactEvent({
		repository,
		event: normalizeContactEvent({
			provider: 'kit',
			externalId: '123',
			email,
			providerEventId: 'signup-1',
			eventType: 'skills-newsletter.subscribed',
			occurredAt: signedUpAt,
			message: 'Test signup',
			privacyLevel: 'internal',
		}),
	})
	const contactId = capture.contact.id
	const providerIdentityId = capture.providerIdentity.id
	const record = (eventType: string, occurredAt: string) =>
		repository.createContactEvent({
			...normalizeContactEvent({
				provider: 'kit',
				externalId: '123',
				email,
				providerEventId: `${eventType}:${occurredAt}`,
				eventType,
				occurredAt,
				message: 'Fixture',
				privacyLevel: 'internal',
			}),
			providerReference: OLD_NEWSLETTER_REFERENCE,
			contactId,
			providerIdentityId,
			createdAt: occurredAt,
		})
	record(OLD_NEWSLETTER_SUBSCRIBED, signedUpAt)
	record('newsletter.exit-required', signedUpAt)
	await ensureShadowNewsletterOwnershipAssignment({
		repository,
		contactId,
		providerIdentityId,
		kitSubscriberId: '123',
		email,
		occurredAt: signedUpAt,
	})
	repository.createSideEffectIntent({
		id: 'handoff',
		nextActionId: 'drovr:handoff',
		contactId,
		provider: 'kit',
		type: 'subscribe-evergreen-list',
		status: 'pending',
		idempotencyKey: 'handoff',
		gates: [],
		reviewReasons: [],
		createdAt: signedUpAt,
		metadata: { kitSequenceId: '2625552', list: 'shadow-newsletter' },
	})
	const drain = () =>
		executePendingEvergreenSends({
			repository,
			subscribe: vi.fn(async () => 'added'),
			dispatch: vi.fn(),
			type: 'subscribe-evergreen-list',
			limit: 5,
			now: () => now,
		})
	await drain()
	expect(repository.sideEffectIntents.get('handoff')?.status).toBe(
		'held-for-exit',
	)
	const send = vi.fn(async () => undefined)
	const pass = (
		options: {
			enabled?: boolean
			statuses?: string[]
		} = {},
	) =>
		runPurchaseHandoffExitPass({
			repository,
			isEnabled: async () => options.enabled ?? true,
			findCrashCoursePurchaseStatuses: async () => options.statuses ?? ['Valid'],
			now,
			send,
		})
	return { repository, contactId, drain, pass, send }
}

describe('purchase handoff exit proof', () => {
	it('admits a buyer whose drovr handoff is held, with a distinct proof kind', async () => {
		const { repository, contactId, pass, drain, send } = await heldHandoff()
		const result = await pass()
		expect(result).toMatchObject({
			status: 'ran',
			results: [{ contactId, outcome: 'admitted' }],
		})
		const receipts = repository.findContactEventsByType(
			contactId,
			OLD_NEWSLETTER_EXIT_CONFIRMED,
		)
		expect(receipts).toHaveLength(1)
		expect(JSON.parse(receipts[0]!.payloadSummary?.summary ?? '{}')).toMatchObject({
			proofKind: 'purchase-handoff',
		})
		expect(await readOldSequenceMembership(repository, contactId)).toBe(
			'exited',
		)
		expect(send).toHaveBeenCalledTimes(1)
		expect(repository.sideEffectIntents.get('handoff')).toMatchObject({
			status: 'pending',
			metadata: { exitReceiptId: receipts[0]!.id },
		})
		expect(await drain()).toMatchObject([{ status: 'completed' }])
	})

	it('keeps a non-buyer held', async () => {
		const { repository, contactId, pass, send } = await heldHandoff()
		expect(await pass({ statuses: [] })).toMatchObject({
			results: [{ contactId, outcome: 'no-active-purchase' }],
		})
		expect(
			repository.findContactEventsByType(contactId, OLD_NEWSLETTER_EXIT_CONFIRMED),
		).toHaveLength(0)
		expect(repository.sideEffectIntents.get('handoff')?.status).toBe(
			'held-for-exit',
		)
		expect(send).not.toHaveBeenCalled()
	})

	it('keeps a refunded buyer held', async () => {
		const { repository, contactId, pass, send } = await heldHandoff()
		expect(await pass({ statuses: ['Refunded'] })).toMatchObject({
			results: [{ contactId, outcome: 'no-active-purchase' }],
		})
		expect(
			repository.findContactEventsByType(contactId, OLD_NEWSLETTER_EXIT_CONFIRMED),
		).toHaveLength(0)
		expect(repository.sideEffectIntents.get('handoff')?.status).toBe(
			'held-for-exit',
		)
		expect(send).not.toHaveBeenCalled()
	})

	it('does nothing with the flag off', async () => {
		const { repository, contactId, pass, send } = await heldHandoff()
		const lookup = vi.fn(async () => ['Valid'])
		const result = await runPurchaseHandoffExitPass({
			repository,
			isEnabled: async () => false,
			findCrashCoursePurchaseStatuses: lookup,
			now,
			send,
		})
		expect(result).toEqual({ status: 'disabled' })
		expect(lookup).not.toHaveBeenCalled()
		expect(
			repository.findContactEventsByType(contactId, OLD_NEWSLETTER_EXIT_CONFIRMED),
		).toHaveLength(0)
		expect(repository.sideEffectIntents.get('handoff')?.status).toBe(
			'held-for-exit',
		)
		void pass
	})

	it('fails closed when the flag read throws', async () => {
		const { repository, contactId, send } = await heldHandoff()
		const result = await runPurchaseHandoffExitPass({
			repository,
			isEnabled: async () => {
				throw new Error('redis down')
			},
			findCrashCoursePurchaseStatuses: async () => ['Valid'],
			now,
			send,
		})
		expect(result).toEqual({ status: 'disabled' })
		expect(
			repository.findContactEventsByType(contactId, OLD_NEWSLETTER_EXIT_CONFIRMED),
		).toHaveLength(0)
	})

	it('is a no-op on replay: one receipt, one admission', async () => {
		const { repository, contactId, pass, send } = await heldHandoff()
		await pass()
		const again = await pass()
		expect(again).toMatchObject({ status: 'ran', results: [] })
		expect(
			repository.findContactEventsByType(contactId, OLD_NEWSLETTER_EXIT_CONFIRMED),
		).toHaveLength(1)
		expect(
			repository.findContactEventsByType(contactId, 'newsletter.admission.resumed'),
		).toHaveLength(1)
		expect(send).toHaveBeenCalledTimes(1)
	})

	it('finishes a lost wakeup from its own receipt without a second one', async () => {
		const { repository, contactId, pass } = await heldHandoff()
		await pass()
		const row = repository.sideEffectIntents.get('handoff')!
		repository.sideEffectIntents.set('handoff', {
			...row,
			status: 'held-for-exit',
		})
		expect(await pass()).toMatchObject({
			results: [{ contactId, outcome: 'replayed-existing-receipt' }],
		})
		expect(
			repository.findContactEventsByType(contactId, OLD_NEWSLETTER_EXIT_CONFIRMED),
		).toHaveLength(1)
		expect(repository.sideEffectIntents.get('handoff')?.status).toBe('pending')
	})

	it('does not trust a handoff that is not drovr shadow-newsletter', async () => {
		const { repository, contactId, pass, send } = await heldHandoff()
		const row = repository.sideEffectIntents.get('handoff')!
		repository.sideEffectIntents.set('handoff', {
			...row,
			metadata: { ...row.metadata, list: 'something-else' },
		})
		expect(await pass()).toMatchObject({ results: [] })
		expect(
			repository.findContactEventsByType(contactId, OLD_NEWSLETTER_EXIT_CONFIRMED),
		).toHaveLength(0)
		expect(send).not.toHaveBeenCalled()
	})
})
