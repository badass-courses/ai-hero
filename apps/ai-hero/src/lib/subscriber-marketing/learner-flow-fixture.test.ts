import { describe, expect, it } from 'vitest'

import {
	cleanupLearnerFlowStuckFixture,
	createLearnerFlowStuckFixture,
	isCleanedLearnerFlowFixtureIntent,
	isLearnerFlowFixtureEmail,
	learnerFlowFixtureEmail,
	type LearnerFlowFixtureRepository,
} from './learner-flow-fixture'
import { classifyLearnerFlowContact, isCourseValuePathIntent } from './learner-flow-classifier'
import type { ContactRecord, ContactState, SideEffectIntent } from './types'

class FixtureRepository implements LearnerFlowFixtureRepository {
	contacts = new Map<string, ContactRecord>()
	states = new Map<string, ContactState>()
	intents = new Map<string, SideEffectIntent>()
	contactSequence = 0

	async findContactById(id: string) {
		return this.contacts.get(id)
	}

	async findContactByEmail(email: string) {
		return Array.from(this.contacts.values()).find(
			(contact) => contact.email === email,
		)
	}

	async createContact(input: Omit<ContactRecord, 'id'>) {
		const contact = { id: `contact-${++this.contactSequence}`, ...input }
		this.contacts.set(contact.id, contact)
		return contact
	}

	async upsertContactState(state: ContactState) {
		this.states.set(state.contactId, state)
		return state
	}

	async findValuePathEmailSideEffectIntentsByContact(contactId: string) {
		return Array.from(this.intents.values()).filter(
			(intent) => intent.contactId === contactId,
		)
	}

	async createSideEffectIntent(intent: SideEffectIntent) {
		this.intents.set(intent.id, intent)
		return intent
	}

	async updateSideEffectIntent(
		id: string,
		patch: Pick<
			SideEffectIntent,
			'status' | 'gates' | 'reviewReasons' | 'metadata'
		>,
	) {
		const current = this.intents.get(id)
		if (!current) throw new Error(`Missing intent ${id}`)
		const updated = { ...current, ...patch }
		this.intents.set(id, updated)
		return updated
	}
}

const now = '2026-07-16T16:30:00.000Z'

describe('learner-flow stuck fixture', () => {
	it('plans without writing unless --allow-write is represented', async () => {
		const repository = new FixtureRepository()
		const result = await createLearnerFlowStuckFixture({
			repository,
			fixtureId: 'fixture-1',
			allowWrite: false,
			now,
		})

		expect(result).toMatchObject({
			operation: 'create',
			allowWrite: false,
			created: false,
			intentStatus: 'blocked',
		})
		expect(repository.contacts.size).toBe(0)
		expect(repository.intents.size).toBe(0)
	})

	it('creates the exact synthetic blocked email-0 tier-1 shape', async () => {
		const repository = new FixtureRepository()
		const result = await createLearnerFlowStuckFixture({
			repository,
			fixtureId: 'fixture-2',
			allowWrite: true,
			now,
		})
		const contact = repository.contacts.get(result.contactId!)!
		const intent = repository.intents.get(result.intentId!)!

		expect(isLearnerFlowFixtureEmail(contact.email)).toBe(true)
		expect(contact.email).toBe(learnerFlowFixtureEmail('fixture-2'))
		expect(repository.states.get(contact.id)).toMatchObject({
			lifecycle: 'nurture-ready',
			humanReview: false,
		})
		expect(intent).toMatchObject({
			contactId: contact.id,
			provider: 'kit',
			type: 'send-value-path-email',
			status: 'blocked',
			metadata: {
				valuePathSlug: 'ai-hero-skills-workflow',
				emailResourceId: 'ai-hero-skills-workflow.email-0',
				kitSequenceId: '2757199',
				learnerFlowFixture: true,
				learnerFlowFixtureStatus: 'active',
			},
		})
		expect(
			classifyLearnerFlowContact({
				contactId: contact.id,
				contact,
				contactState: repository.states.get(contact.id),
				intents: [intent],
				now,
			}),
		).toMatchObject({
			state: 'stuck',
			cause: 'blocked-intent',
			intentId: intent.id,
		})
	})

	it('cleans only marked synthetic fixture intents and removes them from learner flow', async () => {
		const repository = new FixtureRepository()
		const created = await createLearnerFlowStuckFixture({
			repository,
			fixtureId: 'fixture-3',
			allowWrite: true,
			now,
		})
		const cleaned = await cleanupLearnerFlowStuckFixture({
			repository,
			contactId: created.contactId!,
			allowWrite: true,
			now: '2026-07-16T16:35:00.000Z',
		})
		const intent = repository.intents.get(created.intentId!)!

		expect(cleaned.counts).toEqual({
			fixtureIntents: 1,
			active: 1,
			skipped: 1,
			wouldSkip: 0,
			alreadyCleaned: 0,
		})
		expect(isCleanedLearnerFlowFixtureIntent(intent)).toBe(true)
		expect(isCourseValuePathIntent(intent)).toBe(false)
	})

	it('refuses cleanup for a real contact', async () => {
		const repository = new FixtureRepository()
		const contact = await repository.createContact({
			email: 'customer@example.com',
			lifecycle: 'nurture-ready',
			isProvisional: false,
			createdAt: now,
			updatedAt: now,
		})

		await expect(
			cleanupLearnerFlowStuckFixture({
				repository,
				contactId: contact.id,
				allowWrite: true,
				now,
			}),
		).rejects.toThrow('contact is not a synthetic fixture address')
	})
})
