import { describe, expect, it } from 'vitest'

import {
	acceptDrovrIntent,
	drovrCompletionForIntent,
	type DrovrExecutorRepository,
	type DrovrIntent,
} from './drovr-executor'
import type { ContactRecord, SideEffectIntent } from './types'

const now = '2026-09-16T22:30:00.000Z'

class FakeRepository implements DrovrExecutorRepository {
	contacts = new Map<string, ContactRecord>()
	intents = new Map<string, SideEffectIntent>()

	findContactById(id: string) {
		return this.contacts.get(id)
	}
	/** Rows a concurrent writer inserts between the read and the insert. */
	raceRows: SideEffectIntent[] = []
	findSideEffectIntentByIdempotencyKey(idempotencyKey: string) {
		return Array.from(this.intents.values()).find(
			(intent) => intent.idempotencyKey === idempotencyKey,
		)
	}
	private admitRacers() {
		for (const row of this.raceRows.splice(0)) this.intents.set(row.id, row)
	}
	createSideEffectIntent(input: SideEffectIntent) {
		this.admitRacers()
		if (this.findSideEffectIntentByIdempotencyKey(input.idempotencyKey)) {
			throw new Error(
				"Duplicate entry for key 'SideEffectIntent_idempotencyKey_uq'",
			)
		}
		this.intents.set(input.id, input)
		return input
	}
	findValuePathEmailSideEffectIntentsByContact(contactId: string) {
		return Array.from(this.intents.values())
			.filter((intent) => intent.contactId === contactId)
			.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
	}
}

const contact = (): ContactRecord => ({
	id: 'contact-1',
	email: 'learner@example.com',
	name: 'Learner',
	lifecycle: 'nurture-ready',
	isProvisional: false,
	createdAt: now,
	updatedAt: now,
})

const intent = (overrides: Partial<DrovrIntent> = {}): DrovrIntent => ({
	tenantId: 'org-aihero',
	contactId: 'contact-1',
	journeyId: 'value-path-skills-course',
	kind: 'email.send',
	idempotencyKey:
		'intent:org-aihero:contact-1:value-path-skills-course:email0.pending:contact.created:0',
	dueAt: now,
	payload: { emailResourceId: 'ai-hero-skills-workflow.email-0' },
	...overrides,
})

describe('drovr executor: accepting an email.send intent', () => {
	it('writes a pending send intent under the legacy key with drovr ownership', async () => {
		const repository = new FakeRepository()
		repository.contacts.set('contact-1', contact())

		const result = await acceptDrovrIntent({
			repository,
			intent: intent(),
			now,
			findKitSubscriberId: async () => 'kit-123',
		})

		expect(result.status).toBe('accepted')
		if (result.status !== 'accepted') return
		expect(result.created).toBe(true)
		expect(result.idempotencyKey).toBe(
			'contact:contact-1:value-path:ai-hero-skills-workflow:email:ai-hero-skills-workflow.email-0',
		)
		const row = repository.intents.get(result.intentId)
		expect(row).toMatchObject({
			provider: 'kit',
			type: 'send-value-path-email',
			status: 'pending',
			nextActionId: expect.stringMatching(/^drovr:[0-9a-f]{40}$/),
			metadata: {
				source: 'drovr',
				drovr: {
					tenantId: 'org-aihero',
					journeyId: 'value-path-skills-course',
					intentKey: intent().idempotencyKey,
					dueAt: now,
				},
				valuePathSlug: 'ai-hero-skills-workflow',
				emailResourceId: 'ai-hero-skills-workflow.email-0',
				kitSequenceId: '2757199',
				kitSubscriberId: 'kit-123',
			},
		})
	})

	it('is idempotent: a second post for the same email returns the existing row', async () => {
		const repository = new FakeRepository()
		repository.contacts.set('contact-1', contact())
		const first = await acceptDrovrIntent({ repository, intent: intent(), now })
		const second = await acceptDrovrIntent({
			repository,
			intent: intent(),
			now,
		})

		expect(second.status).toBe('accepted')
		if (second.status !== 'accepted' || first.status !== 'accepted') return
		expect(second.created).toBe(false)
		expect(second.intentId).toBe(first.intentId)
		expect(repository.intents.size).toBe(1)
	})

	it('returns the completion inline when ai-hero already sent that email', async () => {
		const repository = new FakeRepository()
		repository.contacts.set('contact-1', contact())
		const first = await acceptDrovrIntent({ repository, intent: intent(), now })
		if (first.status !== 'accepted') throw new Error('expected accepted')
		const row = repository.intents.get(first.intentId)!
		repository.intents.set(row.id, {
			...row,
			status: 'completed',
			completedAt: '2026-09-16T22:35:00.000Z',
		})

		const replay = await acceptDrovrIntent({
			repository,
			intent: intent(),
			now,
		})

		expect(replay.status).toBe('completed')
		if (replay.status !== 'completed') return
		expect(replay.completion).toEqual({
			tenantId: 'org-aihero',
			contactId: 'contact-1',
			journeyId: 'value-path-skills-course',
			type: 'email.completed',
			occurredAt: '2026-09-16T22:35:00.000Z',
			idempotencyKey: `completion:${intent().idempotencyKey}`,
			payload: { emailResourceId: 'ai-hero-skills-workflow.email-0' },
		})
	})

	it('reports a gate-blocked existing intent as blocked with its reasons', async () => {
		const repository = new FakeRepository()
		repository.contacts.set('contact-1', contact())
		const first = await acceptDrovrIntent({ repository, intent: intent(), now })
		if (first.status !== 'accepted') throw new Error('expected accepted')
		const row = repository.intents.get(first.intentId)!
		repository.intents.set(row.id, {
			...row,
			status: 'blocked',
			reviewReasons: ['email-7-copy-approval-required'],
		})

		const result = await acceptDrovrIntent({
			repository,
			intent: intent(),
			now,
		})
		expect(result).toEqual({
			status: 'blocked',
			intentId: row.id,
			reviewReasons: ['email-7-copy-approval-required'],
		})
	})

	it('keeps a contact the click path routed onto the team path on team emails', async () => {
		const repository = new FakeRepository()
		repository.contacts.set('contact-1', contact())
		repository.intents.set('legacy-team-1', {
			id: 'legacy-team-1',
			nextActionId: 'legacy',
			contactId: 'contact-1',
			provider: 'kit',
			type: 'send-value-path-email',
			status: 'completed',
			completedAt: '2026-09-15T22:00:00.000Z',
			idempotencyKey:
				'contact:contact-1:value-path:ai-hero-skills-team-workflow:email:ai-hero-skills-team-workflow.team-email-1',
			gates: [],
			reviewReasons: [],
			metadata: {
				valuePathSlug: 'ai-hero-skills-team-workflow',
				emailResourceId: 'ai-hero-skills-team-workflow.team-email-1',
				kitSubscriberId: 'kit-777',
				courseEntryEventId: 'entry-9',
			},
			createdAt: '2026-09-15T22:00:00.000Z',
		})

		const result = await acceptDrovrIntent({
			repository,
			intent: intent({
				payload: { emailResourceId: 'ai-hero-skills-workflow.email-2' },
			}),
			now,
		})

		expect(result.status).toBe('accepted')
		if (result.status !== 'accepted') return
		expect(result.idempotencyKey).toBe(
			'contact:contact-1:value-path:ai-hero-skills-team-workflow:email:ai-hero-skills-team-workflow.team-email-2',
		)
		expect(repository.intents.get(result.intentId)?.metadata).toMatchObject({
			valuePathSlug: 'ai-hero-skills-team-workflow',
			emailResourceId: 'ai-hero-skills-team-workflow.team-email-2',
			kitSubscriberId: 'kit-777',
			courseEntryEventId: 'entry-9',
		})
	})

	it('refuses kinds, journeys, and emails it cannot execute, and unknown contacts', async () => {
		const repository = new FakeRepository()
		repository.contacts.set('contact-1', contact())

		expect(
			(
				await acceptDrovrIntent({
					repository,
					intent: intent({ kind: 'coupon.issue' }),
					now,
				})
			).status,
		).toBe('unsupported')
		expect(
			(
				await acceptDrovrIntent({
					repository,
					intent: intent({ journeyId: 'crash-course-evergreen-offer' }),
					now,
				})
			).status,
		).toBe('unsupported')
		expect(
			(
				await acceptDrovrIntent({
					repository,
					intent: intent({ payload: { emailResourceId: 'nope.email-99' } }),
					now,
				})
			).status,
		).toBe('unsupported')
		expect(
			(
				await acceptDrovrIntent({
					repository,
					intent: intent({ contactId: 'ghost' }),
					now,
				})
			).status,
		).toBe('contact-missing')
		expect(repository.intents.size).toBe(0)
	})
})

describe('drovr completion for an owned intent', () => {
	it('normalizes a team resource id back to the individual id drovr planned', () => {
		const completion = drovrCompletionForIntent({
			id: 'i',
			nextActionId: 'drovr:k',
			contactId: 'contact-1',
			provider: 'kit',
			type: 'send-value-path-email',
			status: 'completed',
			completedAt: now,
			idempotencyKey: 'x',
			gates: [],
			reviewReasons: [],
			metadata: {
				drovr: {
					tenantId: 'org-aihero',
					journeyId: 'value-path-skills-course',
					intentKey: 'k',
					dueAt: now,
				},
				emailResourceId: 'ai-hero-skills-team-workflow.team-email-3',
			},
			createdAt: now,
		})
		expect(completion?.payload).toEqual({
			emailResourceId: 'ai-hero-skills-workflow.email-3',
		})
		expect(completion?.idempotencyKey).toBe('completion:k')
	})
})

describe('drovr executor: edges Macroscope asked about', () => {
	it('survives a duplicate-insert race by answering with the row that won', async () => {
		const repository = new FakeRepository()
		repository.contacts.set('contact-1', contact())
		repository.raceRows.push({
			id: 'raced-row',
			nextActionId: 'legacy',
			contactId: 'contact-1',
			provider: 'kit',
			type: 'send-value-path-email',
			status: 'pending',
			idempotencyKey:
				'contact:contact-1:value-path:ai-hero-skills-workflow:email:ai-hero-skills-workflow.email-0',
			gates: [],
			reviewReasons: [],
			metadata: {},
			createdAt: now,
		})

		const result = await acceptDrovrIntent({
			repository,
			intent: intent(),
			now,
		})

		expect(result).toEqual({
			status: 'accepted',
			intentId: 'raced-row',
			idempotencyKey:
				'contact:contact-1:value-path:ai-hero-skills-workflow:email:ai-hero-skills-workflow.email-0',
			created: false,
		})
		expect(repository.intents.size).toBe(1)
	})

	it('answers a legacy-completed email with a completion addressed to the requester', async () => {
		const repository = new FakeRepository()
		repository.contacts.set('contact-1', contact())
		repository.intents.set('legacy-done', {
			id: 'legacy-done',
			nextActionId: 'legacy',
			contactId: 'contact-1',
			provider: 'kit',
			type: 'send-value-path-email',
			status: 'completed',
			completedAt: '2026-09-10T10:00:00.000Z',
			idempotencyKey:
				'contact:contact-1:value-path:ai-hero-skills-workflow:email:ai-hero-skills-workflow.email-0',
			gates: [],
			reviewReasons: [],
			metadata: {
				valuePathSlug: 'ai-hero-skills-workflow',
				emailResourceId: 'ai-hero-skills-workflow.email-0',
			},
			createdAt: '2026-09-10T09:00:00.000Z',
		})

		const result = await acceptDrovrIntent({
			repository,
			intent: intent(),
			now,
		})

		expect(result).toEqual({
			status: 'completed',
			intentId: 'legacy-done',
			completion: {
				tenantId: 'org-aihero',
				contactId: 'contact-1',
				journeyId: 'value-path-skills-course',
				type: 'email.completed',
				occurredAt: '2026-09-10T10:00:00.000Z',
				idempotencyKey: `completion:${intent().idempotencyKey}`,
				payload: { emailResourceId: 'ai-hero-skills-workflow.email-0' },
			},
		})
	})

	it('bounds nextActionId for an unbounded drovr key', async () => {
		const repository = new FakeRepository()
		repository.contacts.set('contact-1', contact())
		const result = await acceptDrovrIntent({
			repository,
			intent: intent({ idempotencyKey: `intent:${'x'.repeat(600)}` }),
			now,
		})
		expect(result.status).toBe('accepted')
		if (result.status !== 'accepted') return
		const row = repository.intents.get(result.intentId)!
		expect(row.nextActionId.length).toBeLessThanOrEqual(255)
		expect(row.metadata).toMatchObject({
			drovr: { intentKey: `intent:${'x'.repeat(600)}` },
		})
	})

	it('refuses an intent due in the future instead of letting the cron send it early', async () => {
		const repository = new FakeRepository()
		repository.contacts.set('contact-1', contact())
		const result = await acceptDrovrIntent({
			repository,
			intent: intent({ dueAt: '2026-09-17T22:30:00.000Z' }),
			now,
		})
		expect(result).toMatchObject({
			status: 'unsupported',
			reason: expect.stringContaining('1440 minutes ahead'),
		})
		expect(repository.intents.size).toBe(0)
	})

	it('tolerates a few minutes of skew and a due time in the past', async () => {
		const repository = new FakeRepository()
		repository.contacts.set('contact-1', contact())
		for (const dueAt of [
			'2026-09-16T22:33:00.000Z',
			'2026-09-16T20:00:00.000Z',
		]) {
			repository.intents.clear()
			const result = await acceptDrovrIntent({
				repository,
				intent: intent({ dueAt }),
				now,
			})
			expect(result.status).toBe('accepted')
		}
	})
})

describe('acceptDrovrIntent: evergreen bridge and pitch sends', () => {
	const evergreenIntent = (overrides: Partial<DrovrIntent> = {}): DrovrIntent =>
		intent({
			journeyId: 'crash-course-evergreen-offer',
			idempotencyKey: 'contact-1:crash-course-evergreen-offer:send:B1',
			payload: { messageId: 'bridge_can_engineer_v1', slot: 'B1' },
			...overrides,
		})
	const enabled = { enabled: true } as const

	it('refuses with a hint while the rollout flag is off', async () => {
		const repository = new FakeRepository()
		repository.contacts.set('contact-1', contact())
		const result = await acceptDrovrIntent({
			repository,
			intent: evergreenIntent(),
			now,
		})
		expect(result.status).toBe('unsupported')
		if (result.status !== 'unsupported') throw new Error('unreachable')
		expect(result.hint).toContain('AIH_DROVR_EVERGREEN_ENABLED')
		expect(repository.intents.size).toBe(0)
	})

	it('accepts a known message as a send-evergreen-email row bound to its Kit sequence', async () => {
		const repository = new FakeRepository()
		repository.contacts.set('contact-1', contact())
		const result = await acceptDrovrIntent({
			repository,
			intent: evergreenIntent(),
			now,
			evergreen: enabled,
			findKitSubscriberId: async () => 'kit-123',
		})
		expect(result.status).toBe('accepted')
		if (result.status !== 'accepted') throw new Error('unreachable')
		expect(result.created).toBe(true)
		const row = repository.intents.get(result.intentId)
		expect(row).toMatchObject({
			provider: 'kit',
			type: 'send-evergreen-email',
			status: 'pending',
			idempotencyKey: 'contact:contact-1:evergreen:bridge_can_engineer_v1',
			metadata: {
				source: 'drovr',
				messageId: 'bridge_can_engineer_v1',
				slot: 'B1',
				kitSequenceId: '2887679',
				kitSubscriberId: 'kit-123',
				drovr: {
					tenantId: 'org-aihero',
					journeyId: 'crash-course-evergreen-offer',
					intentKey: 'contact-1:crash-course-evergreen-offer:send:B1',
				},
			},
		})
		expect(row?.nextActionId).toMatch(/^drovr:[0-9a-f]{40}$/)
	})

	it('answers a repeat with the existing row instead of a second send', async () => {
		const repository = new FakeRepository()
		repository.contacts.set('contact-1', contact())
		const first = await acceptDrovrIntent({
			repository,
			intent: evergreenIntent(),
			now,
			evergreen: enabled,
		})
		const second = await acceptDrovrIntent({
			repository,
			intent: evergreenIntent({ idempotencyKey: 'redriven-key' }),
			now,
			evergreen: enabled,
		})
		expect(second.status).toBe('accepted')
		if (first.status !== 'accepted' || second.status !== 'accepted') {
			throw new Error('unreachable')
		}
		expect(second.intentId).toBe(first.intentId)
		expect(second.created).toBe(false)
		expect(repository.intents.size).toBe(1)
	})

	it('answers a completed row with an email.completed addressed to the requester', async () => {
		const repository = new FakeRepository()
		repository.contacts.set('contact-1', contact())
		const accepted = await acceptDrovrIntent({
			repository,
			intent: evergreenIntent(),
			now,
			evergreen: enabled,
		})
		if (accepted.status !== 'accepted') throw new Error('unreachable')
		const row = repository.intents.get(accepted.intentId)!
		repository.intents.set(row.id, {
			...row,
			status: 'completed',
			completedAt: '2026-09-17T16:00:00.000Z',
		})
		const result = await acceptDrovrIntent({
			repository,
			intent: evergreenIntent({ idempotencyKey: 'redriven-key' }),
			now,
			evergreen: enabled,
		})
		expect(result).toMatchObject({
			status: 'completed',
			intentId: row.id,
			completion: {
				tenantId: 'org-aihero',
				contactId: 'contact-1',
				journeyId: 'crash-course-evergreen-offer',
				type: 'email.completed',
				occurredAt: '2026-09-17T16:00:00.000Z',
				idempotencyKey: 'completion:redriven-key',
				payload: { messageId: 'bridge_can_engineer_v1' },
			},
		})
	})

	it('refuses an unknown message id and non-send kinds', async () => {
		const repository = new FakeRepository()
		repository.contacts.set('contact-1', contact())
		const unknown = await acceptDrovrIntent({
			repository,
			intent: evergreenIntent({ payload: { messageId: 'nope_v9' } }),
			now,
			evergreen: enabled,
		})
		expect(unknown.status).toBe('unsupported')
		const coupon = await acceptDrovrIntent({
			repository,
			intent: evergreenIntent({ kind: 'coupon.issue', payload: {} }),
			now,
			evergreen: enabled,
		})
		expect(coupon.status).toBe('unsupported')
		expect(repository.intents.size).toBe(0)
	})
})

describe('acceptDrovrIntent: evergreen coupon issue', () => {
	const couponPayload = {
		productId: 'product-ma254',
		amountOffCents: 10_000,
		maxUses: 1,
		exclusive: true,
		regularPriceCents: 29_900,
		effectivePriceCents: 19_900,
		issueAt: '2026-09-10T16:00:00.000Z',
		expiresAt: '2026-09-15T06:59:59.000Z',
		timezone: 'America/Los_Angeles',
		timezoneSource: 'vercel-header',
	}
	const couponIntent = (overrides: Partial<DrovrIntent> = {}): DrovrIntent =>
		intent({
			journeyId: 'crash-course-evergreen-offer',
			kind: 'coupon.issue',
			idempotencyKey: 'contact-1:crash-course-evergreen-offer:coupon',
			payload: couponPayload,
			...overrides,
		})
	const enabled = { enabled: true } as const

	it('accepts a v3 coupon.issue as one issue-evergreen-coupon row per contact', async () => {
		const repository = new FakeRepository()
		repository.contacts.set('contact-1', contact())
		const result = await acceptDrovrIntent({
			repository,
			intent: couponIntent(),
			now,
			evergreen: enabled,
			findKitSubscriberId: async () => 'kit-123',
		})
		expect(result.status).toBe('accepted')
		if (result.status !== 'accepted') throw new Error('unreachable')
		expect(repository.intents.get(result.intentId)).toMatchObject({
			type: 'issue-evergreen-coupon',
			idempotencyKey: 'contact:contact-1:evergreen:coupon',
			metadata: { offer: couponPayload, kitSubscriberId: 'kit-123' },
		})
		const again = await acceptDrovrIntent({
			repository,
			intent: couponIntent({ idempotencyKey: 'redriven' }),
			now,
			evergreen: enabled,
		})
		expect(again).toMatchObject({ status: 'accepted', created: false })
		expect(repository.intents.size).toBe(1)
	})

	it('accepts a shadow-newsletter list.subscribe as one subscribe-evergreen-list row per contact', async () => {
		const repository = new FakeRepository()
		repository.contacts.set('contact-1', contact())
		const listIntent = (overrides: Partial<DrovrIntent> = {}) =>
			couponIntent({
				kind: 'list.subscribe',
				payload: { list: 'shadow-newsletter' },
				idempotencyKey: 'k-list',
				...overrides,
			})
		const result = await acceptDrovrIntent({
			repository,
			intent: listIntent(),
			now,
			evergreen: enabled,
		})
		expect(result.status).toBe('accepted')
		if (result.status !== 'accepted') throw new Error('unreachable')
		expect(repository.intents.get(result.intentId)).toMatchObject({
			type: 'subscribe-evergreen-list',
			idempotencyKey: 'contact:contact-1:evergreen:list:shadow-newsletter',
			metadata: { list: 'shadow-newsletter', kitSequenceId: '2625552' },
		})
		const row = repository.intents.get(result.intentId)!
		repository.intents.set(row.id, {
			...row,
			status: 'completed',
			completedAt: '2026-09-10T16:00:05.000Z',
		})
		const again = await acceptDrovrIntent({
			repository,
			intent: listIntent({ idempotencyKey: 'redriven' }),
			now,
			evergreen: enabled,
		})
		expect(again).toMatchObject({
			status: 'completed',
			completion: {
				type: 'shadow.entered',
				idempotencyKey: 'completion:redriven',
				occurredAt: '2026-09-10T16:00:05.000Z',
				payload: { list: 'shadow-newsletter' },
			},
		})
		expect(repository.intents.size).toBe(1)
		const unknown = await acceptDrovrIntent({
			repository,
			intent: listIntent({ payload: { list: 'not-a-list' } }),
			now,
			evergreen: enabled,
		})
		expect(unknown.status).toBe('unsupported')
	})

	it('refuses a coupon.issue without the pinned window (v1/v2 journeys)', async () => {
		const repository = new FakeRepository()
		repository.contacts.set('contact-1', contact())
		const result = await acceptDrovrIntent({
			repository,
			intent: couponIntent({
				payload: { productId: 'product-ma254', amountOffCents: 10_000 },
			}),
			now,
			evergreen: enabled,
		})
		expect(result.status).toBe('unsupported')
		if (result.status !== 'unsupported') throw new Error('unreachable')
		expect(result.hint).toContain('v3')
		expect(repository.intents.size).toBe(0)
	})

	it('answers a completed coupon row with coupon.issued carrying the coupon id and expiry', async () => {
		const repository = new FakeRepository()
		repository.contacts.set('contact-1', contact())
		const accepted = await acceptDrovrIntent({
			repository,
			intent: couponIntent(),
			now,
			evergreen: enabled,
		})
		if (accepted.status !== 'accepted') throw new Error('unreachable')
		const row = repository.intents.get(accepted.intentId)!
		repository.intents.set(row.id, {
			...row,
			status: 'completed',
			completedAt: '2026-09-10T16:00:05.000Z',
			metadata: {
				...row.metadata,
				couponId: 'eoj-coupon:abc',
				expiresAt: couponPayload.expiresAt,
			},
		})
		const result = await acceptDrovrIntent({
			repository,
			intent: couponIntent({ idempotencyKey: 'redriven' }),
			now,
			evergreen: enabled,
		})
		expect(result).toMatchObject({
			status: 'completed',
			completion: {
				type: 'coupon.issued',
				journeyId: 'crash-course-evergreen-offer',
				occurredAt: '2026-09-10T16:00:05.000Z',
				idempotencyKey: 'completion:redriven',
				payload: {
					couponId: 'eoj-coupon:abc',
					expiresAt: couponPayload.expiresAt,
				},
			},
		})
	})
})
