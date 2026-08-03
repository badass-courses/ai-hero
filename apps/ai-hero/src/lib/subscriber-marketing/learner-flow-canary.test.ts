import { describe, expect, it, vi } from 'vitest'

import {
	cleanupLearnerFlowCanary,
	inspectLearnerFlowCanary,
	seedLearnerFlowCanary,
	tickLearnerFlowCanary,
	type LearnerFlowCanaryRepository,
	type LearnerFlowCanaryResidue,
} from './learner-flow-canary'
import { isLearnerFlowCanaryEmail } from './learner-flow-fixture'
import type { ContactRecord, ContactState, SideEffectIntent } from './types'

class CanaryRepository implements LearnerFlowCanaryRepository {
	contacts = new Map<string, ContactRecord>()
	states = new Map<string, ContactState>()
	intents = new Map<string, SideEffectIntent>()
	contactSequence = 0

	async findContactById(id: string) {
		return this.contacts.get(id)
	}

	async findContactByEmail(email: string) {
		return Array.from(this.contacts.values()).find((contact) => contact.email === email)
	}

	async findLearnerFlowCanaryContacts() {
		return Array.from(this.contacts.values()).filter((contact) =>
			isLearnerFlowCanaryEmail(contact.email),
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
		return Array.from(this.intents.values()).filter((intent) => intent.contactId === contactId)
	}

	async createSideEffectIntent(intent: SideEffectIntent) {
		this.intents.set(intent.id, intent)
		return intent
	}

	async updateSideEffectIntent(
		id: string,
		patch: Pick<SideEffectIntent, 'status' | 'gates' | 'reviewReasons' | 'metadata'>,
	) {
		const current = this.intents.get(id)
		if (!current) throw new Error(`Missing intent ${id}`)
		const updated = { ...current, ...patch }
		this.intents.set(id, updated)
		return updated
	}

	async deleteLearnerFlowFixtureContact(contactId: string) {
		this.contacts.delete(contactId)
		this.states.delete(contactId)
		for (const [id, intent] of this.intents) {
			if (intent.contactId === contactId) this.intents.delete(id)
		}
	}

	async readLearnerFlowFixtureResidue(contactId: string): Promise<LearnerFlowCanaryResidue> {
		const contacts = this.contacts.has(contactId) ? 1 : 0
		const contactStates = this.states.has(contactId) ? 1 : 0
		const sideEffectIntents = Array.from(this.intents.values()).filter(
			(intent) => intent.contactId === contactId,
		).length
		return {
			contacts,
			contactStates,
			providerIdentities: 0,
			contactEvents: 0,
			stateTransitions: 0,
			nextActions: 0,
			sideEffectIntents,
			contactLinks: 0,
			conversionUploads: 0,
			total: contacts + contactStates + sideEffectIntents,
		}
	}
}

const now = '2026-07-17T22:00:00.000Z'
function createdIntentId(result: Awaited<ReturnType<typeof seedLearnerFlowCanary>>) {
	if ('intentId' in result) return result.intentId
	throw new Error('Canary seed did not create an intent')
}

const progressionResult = {
	mode: 'allow-write' as const,
	counts: {
		completedIntents: 1,
		planned: 1,
		blocked: 0,
		terminal: 0,
		idempotentNoop: 0,
		notDue: 0,
	},
	results: [],
}

describe('learner-flow canary', () => {
	it('plans a seed without writing, then seeds one pending real-pipeline intent', async () => {
		const repository = new CanaryRepository()
		const dryRun = await tickLearnerFlowCanary({
			repository,
			advance: vi.fn(),
			allowWrite: false,
			now,
		})
		expect(dryRun).toMatchObject({
			lifecycle: 'absent',
			plannedAction: 'seed',
		})
		expect(repository.contacts.size).toBe(0)

		const seeded = await tickLearnerFlowCanary({
			repository,
			advance: vi.fn(),
			allowWrite: true,
			now,
		})
		const contact = Array.from(repository.contacts.values())[0]!
		const intent = Array.from(repository.intents.values())[0]!
		expect(seeded).toMatchObject({ action: 'seeded' })
		expect(isLearnerFlowCanaryEmail(contact.email)).toBe(true)
		expect(intent).toMatchObject({
			status: 'pending',
			metadata: {
				learnerFlowCanary: true,
				learnerFlowCanaryCadenceHours: 1,
			},
		})
	})

	it('fires the structured critical alarm for a synthetic old blocked intent', async () => {
		const repository = new CanaryRepository()
		await seedLearnerFlowCanary({
			repository,
			allowWrite: true,
			stalled: true,
			now: '2026-07-17T20:00:00.000Z',
		})
		const result = await tickLearnerFlowCanary({
			repository,
			advance: vi.fn(),
			allowWrite: false,
			now,
		})
		expect(result).toMatchObject({
			lifecycle: 'stalled',
			plannedAction: 'alarm-only',
			alarm: {
				event: 'subscriber_funnel.canary_stalled',
				severity: 'critical',
				intentStatus: 'blocked',
				ageHours: 2,
			},
		})
	})

	it('uses the real progression seam with an accelerated virtual clock', async () => {
		const repository = new CanaryRepository()
		const created = await seedLearnerFlowCanary({
			repository,
			allowWrite: true,
			now: '2026-07-17T21:50:00.000Z',
		})
		const intent = repository.intents.get(createdIntentId(created)!)!
		await repository.updateSideEffectIntent(intent.id, {
			status: 'completed',
			gates: intent.gates,
			reviewReasons: [],
			metadata: {
				...intent.metadata,
				completedAt: '2026-07-17T21:55:00.000Z',
			},
		})
		const advance = vi.fn().mockResolvedValue(progressionResult)
		const result = await tickLearnerFlowCanary({
			repository,
			advance,
			allowWrite: true,
			now,
		})
		expect(result).toMatchObject({
			action: 'advanced',
			virtualCompletedAt: '2026-07-16T22:00:00.000Z',
		})
		expect(advance).toHaveBeenCalledWith(
			expect.objectContaining({
				intent: expect.objectContaining({
					metadata: expect.objectContaining({
						completedAt: '2026-07-16T22:00:00.000Z',
						learnerFlowCanaryVirtualClock: true,
					}),
				}),
				now,
			}),
		)
	})

	it('self-resets after terminal completion and proves old-id zero residue', async () => {
		const repository = new CanaryRepository()
		const created = await seedLearnerFlowCanary({
			repository,
			allowWrite: true,
			now: '2026-07-17T21:50:00.000Z',
		})
		const intent = repository.intents.get(createdIntentId(created)!)!
		await repository.updateSideEffectIntent(intent.id, {
			status: 'completed',
			gates: intent.gates,
			reviewReasons: [],
			metadata: {
				...intent.metadata,
				emailResourceId: 'ai-hero-skills-workflow.email-6',
				kitSequenceId: '2757205',
				completedAt: '2026-07-17T21:55:00.000Z',
			},
		})
		const result = await tickLearnerFlowCanary({
			repository,
			advance: vi.fn(),
			allowWrite: true,
			now,
		})
		expect(result).toMatchObject({
			action: 'self-reset',
			postDeleteReadback: { total: 0 },
			seeded: { intentStatus: 'pending' },
		})
		expect(Array.from(repository.contacts.values())[0]?.id).not.toBe(created.contactId)
	})

	it('cleans the canary namespace idempotently with zero residue', async () => {
		const repository = new CanaryRepository()
		await seedLearnerFlowCanary({
			repository,
			allowWrite: true,
			now,
		})
		const first = await cleanupLearnerFlowCanary({
			repository,
			allowWrite: true,
		})
		const second = await cleanupLearnerFlowCanary({
			repository,
			allowWrite: true,
		})
		expect(first).toMatchObject({
			deleted: 1,
			postDeleteReadback: { total: 0 },
		})
		expect(second).toMatchObject({
			deleted: 0,
			postDeleteReadback: { total: 0 },
		})
		expect(await inspectLearnerFlowCanary({ repository, now })).toMatchObject({
			lifecycle: 'absent',
		})
	})
})
