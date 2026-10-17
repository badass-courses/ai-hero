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
import {
	decidePurchaseHandoffExit,
	runPurchaseHandoffExitPass,
	type PurchaseHandoffExitFacts,
} from './purchase-handoff-exit'
import { ACTIVE_PURCHASE_STATUSES } from '@/lib/crash-course-purchaser-tag'
import { replayNewsletterExitReceipt } from './newsletter-exit-replay'
import { DROVR_EVERGREEN_OFFER_JOURNEY_ID } from './drovr-shadow-emitter'
import { ensureShadowNewsletterOwnershipAssignment } from './skills-newsletter-path-entry'

const signedUpAt = '2026-10-01T12:00:00.000Z'
const now = '2026-10-02T12:00:00.000Z'

afterEach(() => {
	vi.unstubAllEnvs()
})

const buyerEmail = 'reader@example.test'

/** A reader still in the old sequence, held by the admission gate, whose
 * drovr evergreen handoff row sits in held-for-exit. */
async function seedHeldReader(
	repository: InMemorySubscriberMarketingRepository,
	n: number,
	createdAt: string,
	email: string,
) {
	const externalId = String(100 + n)
	const capture = await captureNormalizedContactEvent({
		repository,
		event: normalizeContactEvent({
			provider: 'kit',
			externalId,
			email,
			providerEventId: `signup-${n}`,
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
				externalId,
				email,
				providerEventId: `${eventType}:${occurredAt}:${n}`,
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
		kitSubscriberId: externalId,
		email,
		occurredAt: signedUpAt,
	})
	repository.createSideEffectIntent({
		id: `handoff-${n}`,
		nextActionId: `drovr:handoff-${n}`,
		contactId,
		provider: 'kit',
		type: 'subscribe-evergreen-list',
		status: 'pending',
		idempotencyKey: `handoff-${n}`,
		gates: [],
		reviewReasons: [],
		createdAt,
		metadata: {
			source: 'drovr',
			drovr: { journeyId: DROVR_EVERGREEN_OFFER_JOURNEY_ID },
			kitSequenceId: 'legacy-sequence',
			list: 'shadow-newsletter',
		},
	})
	return { contactId, record }
}

async function holdAll(
	repository: InMemorySubscriberMarketingRepository,
	limit = 50,
) {
	await executePendingEvergreenSends({
		repository,
		subscribe: vi.fn(async () => 'added'),
		dispatch: vi.fn(),
		type: 'subscribe-evergreen-list',
		limit,
		now: () => now,
	})
}

const lookupFor =
	(statuses: string[], only?: string) => async (emails: string[]) =>
		new Map(
			emails
				.filter((email) => !only || email === only)
				.map((email) => [email, statuses] as const),
		)

async function heldHandoff() {
	vi.stubEnv('AIH_SHADOW_NEWSLETTER_EXIT_RULE_READY', '')
	const repository = new InMemorySubscriberMarketingRepository()
	const { contactId, record } = await seedHeldReader(
		repository,
		0,
		signedUpAt,
		buyerEmail,
	)
	await holdAll(repository)
	expect(repository.sideEffectIntents.get('handoff-0')?.status).toBe(
		'held-for-exit',
	)
	const send = vi.fn(async () => undefined)
	const pass = (
		options: {
			enabled?: boolean
			statuses?: string[]
			pageSize?: number
		} = {},
	) =>
		runPurchaseHandoffExitPass({
			repository,
			isEnabled: async () => options.enabled ?? true,
			findCrashCoursePurchaseStatuses: lookupFor(options.statuses ?? ['Valid']),
			now,
			send,
			pageSize: options.pageSize,
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
	return { repository, contactId, drain, pass, send, record }
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
		expect(
			JSON.parse(receipts[0]!.payloadSummary?.summary ?? '{}'),
		).toMatchObject({
			proofKind: 'purchase-handoff',
		})
		expect(await readOldSequenceMembership(repository, contactId)).toBe(
			'exited',
		)
		expect(send).toHaveBeenCalledTimes(1)
		expect(repository.sideEffectIntents.get('handoff-0')).toMatchObject({
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
			repository.findContactEventsByType(
				contactId,
				OLD_NEWSLETTER_EXIT_CONFIRMED,
			),
		).toHaveLength(0)
		expect(repository.sideEffectIntents.get('handoff-0')?.status).toBe(
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
			repository.findContactEventsByType(
				contactId,
				OLD_NEWSLETTER_EXIT_CONFIRMED,
			),
		).toHaveLength(0)
		expect(repository.sideEffectIntents.get('handoff-0')?.status).toBe(
			'held-for-exit',
		)
		expect(send).not.toHaveBeenCalled()
	})

	it('does nothing with the flag off', async () => {
		const { repository, contactId, pass, send } = await heldHandoff()
		const lookup = vi.fn(lookupFor(['Valid']))
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
			repository.findContactEventsByType(
				contactId,
				OLD_NEWSLETTER_EXIT_CONFIRMED,
			),
		).toHaveLength(0)
		expect(repository.sideEffectIntents.get('handoff-0')?.status).toBe(
			'held-for-exit',
		)
	})

	it('fails closed when the flag read throws', async () => {
		const { repository, contactId, send } = await heldHandoff()
		const result = await runPurchaseHandoffExitPass({
			repository,
			isEnabled: async () => {
				throw new Error('redis down')
			},
			findCrashCoursePurchaseStatuses: lookupFor(['Valid']),
			now,
			send,
		})
		expect(result).toEqual({ status: 'disabled' })
		expect(
			repository.findContactEventsByType(
				contactId,
				OLD_NEWSLETTER_EXIT_CONFIRMED,
			),
		).toHaveLength(0)
	})

	it('is a no-op on replay: one receipt, one admission', async () => {
		const { repository, contactId, pass, send } = await heldHandoff()
		await pass()
		const again = await pass()
		expect(again).toMatchObject({ status: 'ran', results: [] })
		expect(
			repository.findContactEventsByType(
				contactId,
				OLD_NEWSLETTER_EXIT_CONFIRMED,
			),
		).toHaveLength(1)
		expect(
			repository.findContactEventsByType(
				contactId,
				'newsletter.admission.resumed',
			),
		).toHaveLength(1)
		expect(send).toHaveBeenCalledTimes(1)
	})

	it('finishes a lost wakeup from its own receipt without a second one', async () => {
		const { repository, contactId, pass } = await heldHandoff()
		await pass()
		const row = repository.sideEffectIntents.get('handoff-0')!
		repository.sideEffectIntents.set('handoff-0', {
			...row,
			status: 'held-for-exit',
		})
		expect(await pass()).toMatchObject({
			results: [{ contactId, outcome: 'replayed-existing-receipt' }],
		})
		expect(
			repository.findContactEventsByType(
				contactId,
				OLD_NEWSLETTER_EXIT_CONFIRMED,
			),
		).toHaveLength(1)
		expect(repository.sideEffectIntents.get('handoff-0')?.status).toBe(
			'pending',
		)
	})

	it('ignores a held handoff for another list', async () => {
		const { repository, contactId, pass, send } = await heldHandoff()
		const row = repository.sideEffectIntents.get('handoff-0')!
		repository.sideEffectIntents.set('handoff-0', {
			...row,
			metadata: { ...row.metadata, list: 'something-else' },
		})
		expect(await pass()).toMatchObject({ results: [] })
		expect(
			repository.findContactEventsByType(
				contactId,
				OLD_NEWSLETTER_EXIT_CONFIRMED,
			),
		).toHaveLength(0)
		expect(send).not.toHaveBeenCalled()
	})
})

describe('purchase handoff exit proof: scope and edges', () => {
	it('accepts a Restricted purchase', async () => {
		const { contactId, pass } = await heldHandoff()
		expect(await pass({ statuses: ['Restricted'] })).toMatchObject({
			results: [{ contactId, outcome: 'admitted' }],
		})
	})

	it('keeps other statuses held', async () => {
		const { pass } = await heldHandoff()
		for (const status of ['Refunded', 'Disputed', 'Banned', 'unknown'])
			expect(await pass({ statuses: [status] })).toMatchObject({
				results: [{ outcome: 'no-active-purchase' }],
			})
	})

	it('does not trust the list name without drovr provenance', async () => {
		const { repository, contactId, pass, send } = await heldHandoff()
		const row = repository.sideEffectIntents.get('handoff-0')!
		const { source: _s, drovr: _d, ...rest } = row.metadata
		repository.sideEffectIntents.set('handoff-0', { ...row, metadata: rest })
		expect(await pass()).toMatchObject({ results: [] })
		repository.sideEffectIntents.set('handoff-0', {
			...row,
			metadata: { ...rest, source: 'drovr', drovr: { journeyId: 'other' } },
		})
		expect(await pass()).toMatchObject({ results: [] })
		expect(
			repository.findContactEventsByType(
				contactId,
				OLD_NEWSLETTER_EXIT_CONFIRMED,
			),
		).toHaveLength(0)
		expect(send).not.toHaveBeenCalled()
	})

	it('reports contact-email-missing and keeps the hold', async () => {
		const { repository, contactId, pass } = await heldHandoff()
		const contact = repository.findContactById(contactId)!
		vi.spyOn(repository, 'findContactById').mockReturnValue({
			...contact,
			email: null,
		} as never)
		expect(await pass()).toMatchObject({
			results: [{ contactId, outcome: 'contact-email-missing' }],
		})
		expect(repository.sideEffectIntents.get('handoff-0')?.status).toBe(
			'held-for-exit',
		)
	})

	it('reports identity-unresolved and writes nothing', async () => {
		const { repository, contactId, pass } = await heldHandoff()
		vi.spyOn(repository, 'findProviderIdentity').mockReturnValue(undefined)
		expect(await pass()).toMatchObject({
			results: [{ contactId, outcome: 'identity-unresolved' }],
		})
		expect(
			repository.findContactEventsByType(
				contactId,
				OLD_NEWSLETTER_EXIT_CONFIRMED,
			),
		).toHaveLength(0)
	})

	it('labels a hold that survives another producer receipt as held-despite-proof', async () => {
		const { repository, contactId, pass, record } = await heldHandoff()
		await record(OLD_NEWSLETTER_EXIT_CONFIRMED, '2026-10-01T18:00:00.000Z')
		expect(await pass()).toMatchObject({
			results: [{ contactId, outcome: 'held-despite-proof' }],
		})
		expect(
			repository.findContactEventsByType(
				contactId,
				OLD_NEWSLETTER_EXIT_CONFIRMED,
			),
		).toHaveLength(1)
	})

	it('does not double-admit when the operator chain replays after this producer', async () => {
		const { repository, contactId, pass, send, record } = await heldHandoff()
		await pass()
		const operator = await record(
			OLD_NEWSLETTER_EXIT_CONFIRMED,
			'2026-10-02T13:00:00.000Z',
		)
		const second = await replayNewsletterExitReceipt({
			repository,
			contactId,
			receiptId: operator.id,
			now: '2026-10-02T13:00:00.000Z',
			send,
		})
		expect(second).toMatchObject({ admissions: 0 })
		expect(send).toHaveBeenCalledTimes(1)
		expect(
			repository.findContactEventsByType(
				contactId,
				'newsletter.admission.resumed',
			),
		).toHaveLength(1)
	})

	it('finds a buyer behind more held non-buyers than a page', async () => {
		vi.stubEnv('AIH_SHADOW_NEWSLETTER_EXIT_RULE_READY', '')
		const repository = new InMemorySubscriberMarketingRepository()
		for (let n = 1; n <= 5; n++)
			await seedHeldReader(
				repository,
				n,
				`2026-10-01T12:00:0${n}.000Z`,
				`other${n}@example.test`,
			)
		const buyer = await seedHeldReader(
			repository,
			9,
			'2026-10-01T12:00:09.000Z',
			buyerEmail,
		)
		await holdAll(repository)
		const send = vi.fn(async () => undefined)
		const result = await runPurchaseHandoffExitPass({
			repository,
			isEnabled: async () => true,
			findCrashCoursePurchaseStatuses: lookupFor(['Valid'], buyerEmail),
			now,
			send,
			pageSize: 2,
		})
		expect(result).toMatchObject({ status: 'ran' })
		const outcomes = (
			result as { results: { contactId: string; outcome: string }[] }
		).results
		expect(outcomes).toHaveLength(6)
		expect(outcomes.find((r) => r.contactId === buyer.contactId)?.outcome).toBe(
			'admitted',
		)
		expect(
			outcomes.filter((r) => r.outcome === 'no-active-purchase'),
		).toHaveLength(5)
	})
})

describe('purchase handoff exit proof: round two', () => {
	it('one throwing row does not stop the buyer behind it', async () => {
		vi.stubEnv('AIH_SHADOW_NEWSLETTER_EXIT_RULE_READY', '')
		const repository = new InMemorySubscriberMarketingRepository()
		const first = await seedHeldReader(
			repository,
			1,
			'2026-10-01T12:00:01.000Z',
			'other@example.test',
		)
		const buyer = await seedHeldReader(
			repository,
			2,
			'2026-10-01T12:00:02.000Z',
			buyerEmail,
		)
		await holdAll(repository)
		const original = repository.findContactById.bind(repository)
		vi.spyOn(repository, 'findContactById').mockImplementation((id) => {
			if (id === first.contactId) throw new Error('boom')
			return original(id)
		})
		const result = await runPurchaseHandoffExitPass({
			repository,
			isEnabled: async () => true,
			findCrashCoursePurchaseStatuses: lookupFor(['Valid']),
			now,
			send: vi.fn(async () => undefined),
		})
		expect(result).toMatchObject({ status: 'ran' })
		const rows = (
			result as { results: { contactId: string; outcome: string }[] }
		).results
		expect(rows.find((r) => r.contactId === first.contactId)?.outcome).toBe(
			'error',
		)
		expect(rows.find((r) => r.contactId === buyer.contactId)?.outcome).toBe(
			'admitted',
		)
	})

	it('does no per-contact event reads for non-buyers', async () => {
		const { repository, pass } = await heldHandoff()
		const events = vi.spyOn(repository, 'findContactEventsByType')
		expect(await pass({ statuses: ['Refunded'] })).toMatchObject({
			results: [{ outcome: 'no-active-purchase' }],
		})
		expect(events).not.toHaveBeenCalled()
	})

	it('re-reads the flag per page and stops when it goes off', async () => {
		vi.stubEnv('AIH_SHADOW_NEWSLETTER_EXIT_RULE_READY', '')
		const repository = new InMemorySubscriberMarketingRepository()
		for (const n of [1, 2])
			await seedHeldReader(
				repository,
				n,
				`2026-10-01T12:00:0${n}.000Z`,
				`other${n}@example.test`,
			)
		await holdAll(repository)
		const isEnabled = vi
			.fn<[], Promise<boolean>>()
			.mockResolvedValueOnce(true)
			.mockResolvedValue(false)
		const result = await runPurchaseHandoffExitPass({
			repository,
			isEnabled,
			findCrashCoursePurchaseStatuses: lookupFor([]),
			now,
			pageSize: 1,
		})
		expect(isEnabled).toHaveBeenCalledTimes(2)
		expect(result).toMatchObject({ status: 'ran' })
		expect((result as { results: unknown[] }).results).toHaveLength(1)
	})

	it('earns a fresh receipt when the reader re-subscribes and is held again', async () => {
		const { repository, contactId, pass, record, send } = await heldHandoff()
		expect(await pass()).toMatchObject({ results: [{ outcome: 'admitted' }] })
		await record(OLD_NEWSLETTER_SUBSCRIBED, '2026-10-05T10:00:00.000Z')
		await record('newsletter.exit-required', '2026-10-05T10:00:00.000Z')
		const first = repository.sideEffectIntents.get('handoff-0')!
		repository.createSideEffectIntent({
			...first,
			id: 'handoff-1',
			nextActionId: 'drovr:handoff-1',
			idempotencyKey: 'handoff-1',
			status: 'pending',
			createdAt: '2026-10-05T10:00:01.000Z',
		})
		await holdAll(repository)
		expect(repository.sideEffectIntents.get('handoff-1')?.status).toBe(
			'held-for-exit',
		)
		const again = await runPurchaseHandoffExitPass({
			repository,
			isEnabled: async () => true,
			findCrashCoursePurchaseStatuses: lookupFor(['Valid']),
			now: '2026-10-06T10:00:00.000Z',
			send,
		})
		// The first hold's row is a no-op replay; the new hold is admitted.
		expect((again as { results: unknown[] }).results).toContainEqual({
			contactId,
			outcome: 'admitted',
		})
		expect(
			repository.findContactEventsByType(
				contactId,
				OLD_NEWSLETTER_EXIT_CONFIRMED,
			),
		).toHaveLength(2)
	})

	it('reports an absent contact as held-not-in-sequence', async () => {
		const { repository, contactId, pass } = await heldHandoff()
		await repository.createContactEvent({
			...normalizeContactEvent({
				provider: 'kit',
				externalId: '100',
				email: buyerEmail,
				providerEventId: 'absent-1',
				eventType: 'newsletter.old-sequence.absent',
				occurredAt: '2026-10-02T00:00:00.000Z',
				message: 'absent',
				privacyLevel: 'internal',
			}),
			payloadSummary: { source: 'drovr-owned-signup' },
			providerReference: OLD_NEWSLETTER_REFERENCE,
			contactId,
			createdAt: '2026-10-02T00:00:00.000Z',
		} as never)
		expect(await pass()).toMatchObject({
			results: [{ contactId, outcome: 'held-not-in-sequence' }],
		})
	})

	it('pins the active purchase statuses', () => {
		expect([...ACTIVE_PURCHASE_STATUSES]).toEqual(['Valid', 'Restricted'])
	})
})

describe('decidePurchaseHandoffExit', () => {
	const base: PurchaseHandoffExitFacts = {
		email: 'a@example.test',
		hasActivePurchase: true,
		hasOwnReceipt: false,
		membership: 'present',
		identityResolved: true,
	}
	it.each([
		[
			'no email',
			{ email: null },
			{ action: 'skip', outcome: 'contact-email-missing' },
		],
		[
			'no purchase',
			{ hasActivePurchase: false },
			{ action: 'skip', outcome: 'no-active-purchase' },
		],
		[
			'own receipt',
			{ hasOwnReceipt: true },
			{ action: 'replay-existing-receipt' },
		],
		[
			'own receipt beats exited',
			{ hasOwnReceipt: true, membership: 'exited' },
			{ action: 'replay-existing-receipt' },
		],
		[
			'exited',
			{ membership: 'exited' },
			{ action: 'skip', outcome: 'held-despite-proof' },
		],
		[
			'absent',
			{ membership: 'absent' },
			{ action: 'skip', outcome: 'held-not-in-sequence' },
		],
		['present', { membership: 'present' }, { action: 'write-receipt' }],
		['unknown', { membership: 'unknown' }, { action: 'write-receipt' }],
		[
			'no identity',
			{ identityResolved: false },
			{ action: 'skip', outcome: 'identity-unresolved' },
		],
		[
			'no purchase beats no identity',
			{ hasActivePurchase: false, identityResolved: false },
			{ action: 'skip', outcome: 'no-active-purchase' },
		],
	] as const)('%s', (_name, patch, expected) => {
		expect(decidePurchaseHandoffExit({ ...base, ...patch })).toEqual(expected)
	})
})
