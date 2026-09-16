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
	findSideEffectIntentByIdempotencyKey(idempotencyKey: string) {
		return Array.from(this.intents.values()).find(
			(intent) => intent.idempotencyKey === idempotencyKey,
		)
	}
	createSideEffectIntent(input: SideEffectIntent) {
		if (this.findSideEffectIntentByIdempotencyKey(input.idempotencyKey)) {
			throw new Error('duplicate idempotency key')
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
			nextActionId: `drovr:${intent().idempotencyKey}`,
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
