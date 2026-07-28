import { createActor } from 'xstate'
import { describe, expect, it } from 'vitest'

import {
	cleanupLearnerFlowDrillFixtures,
	createLearnerFlowDrillFixtures,
	isLearnerFlowDrillEmail,
	learnerFlowDrillEligibility,
	learnerFlowDrillMachine,
	learnerFlowDrillSuppression,
	type LearnerFlowDrillRepository,
} from './learner-flow-drill'
import {
	parseLearnerFlowDrillAxiomOutput,
	parseLearnerFlowDrillPulseOutput,
	runLearnerFlowDrill,
	zombieHealWaitTimeoutMilliseconds,
} from './learner-flow-drill-runner'
import type { ContactRecord, ContactState, SideEffectIntent } from './types'
import type { GateDRuntimeAllowlist } from './value-path-gate-d-allowlist'

class DrillRepository implements LearnerFlowDrillRepository {
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

	async createDriftIntentWithoutCompletionFact(intent: SideEffectIntent) {
		if (intent.completedAt !== null || Object.hasOwn(intent.metadata, 'completedAt')) {
			throw new Error('not a drift shape')
		}
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

	async findLearnerFlowDrillContacts() {
		return Array.from(this.contacts.values()).filter((contact) =>
			isLearnerFlowDrillEmail(contact.email),
		)
	}

	async deleteLearnerFlowFixtureContact(contactId: string) {
		this.contacts.delete(contactId)
		this.states.delete(contactId)
		for (const intent of this.intents.values()) {
			if (intent.contactId === contactId) this.intents.delete(intent.id)
		}
	}

	async readLearnerFlowFixtureResidue(contactId: string) {
		const contacts = Number(this.contacts.has(contactId))
		const contactStates = Number(this.states.has(contactId))
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

const now = '2026-07-18T01:05:00.000Z'

function drillAllowlist(): GateDRuntimeAllowlist {
	return {
		activationId: 'drill-test',
		status: 'active',
		killSwitch: false,
		mode: 'scoped-live',
		authorizationMode: 'rolling-public-enrollment',
		pathSlugs: ['ai-hero-skills-workflow'],
		contactIds: [],
		kitSubscriberIds: [],
		emails: [],
		emailHashes: [],
		emailResourceIds: ['ai-hero-skills-workflow.email-1'],
		kitSequenceIds: ['2757200'],
		candidates: [],
		allowedActions: ['advance-by-daily-drip', 'send-path-emails'],
		createdAt: now,
	}
}

describe('learner flow induced-failure drill', () => {
	it('uses a drill namespace that cannot match a real learner or the canary', () => {
		expect(
			isLearnerFlowDrillEmail(
				'joel+aih-synth-drill-drift-v1-run-1@badass.dev',
			),
		).toBe(true)
		expect(
			isLearnerFlowDrillEmail(
				'joel+aih-synth-drill-zombie-v1-run-1@badass.dev',
			),
		).toBe(true)
		expect(
			isLearnerFlowDrillEmail(
				'joel+aih-synth-canary-learner-v1-run@badass.dev',
			),
		).toBe(false)
		expect(isLearnerFlowDrillEmail('learner@example.com')).toBe(false)
	})

	it('proves the rolling live allowlist can heal fixtures without identity entries', () => {
		const allowlist = drillAllowlist()
		expect(allowlist.contactIds).toEqual([])
		expect(allowlist.kitSubscriberIds).toEqual([])
		expect(allowlist.emails).toEqual([])
		expect(learnerFlowDrillEligibility(allowlist)).toMatchObject({
			passed: true,
			reviewReasons: [],
		})
		expect(
			learnerFlowDrillEligibility({
				...allowlist,
				authorizationMode: 'finish-approved-path',
			}),
		).toMatchObject({
			passed: false,
			reviewReasons: ['authorization-mode-not-rolling-public-enrollment'],
		})
	})

	it('builds three drift fixtures with both completion stamps absent', async () => {
		const fixtures = await createLearnerFlowDrillFixtures({
			repository: new DrillRepository(),
			runId: 'run-a',
			scenario: 'drift',
			allowWrite: false,
			now,
		})
		expect(fixtures).toHaveLength(3)
		expect(fixtures.every((item) => item.intentShape.completedAt === null)).toBe(
			true,
		)
		expect(fixtures.every((item) => !item.intentShape.metadataCompletedAt)).toBe(
			true,
		)
	})

	it('refuses to reuse persisted fixtures under the same run id', async () => {
		const repository = new DrillRepository()
		await createLearnerFlowDrillFixtures({
			repository,
			runId: 'run-reuse',
			scenario: 'drift',
			allowWrite: true,
			now,
		})
		await expect(
			createLearnerFlowDrillFixtures({
				repository,
				runId: 'run-reuse',
				scenario: 'drift',
				allowWrite: true,
				now,
			}),
		).rejects.toThrow('Run learner-flow-drill --cleanup or use a new run id')
	})

	it('suppresses only an active, unexpired zombie drill record', async () => {
		const repository = new DrillRepository()
		const [fixture] = await createLearnerFlowDrillFixtures({
			repository,
			runId: 'run-b',
			scenario: 'zombie',
			allowWrite: true,
			now,
		})
		const contact = repository.contacts.get(fixture!.contactId!)!
		const intent = repository.intents.get(fixture!.intentId!)!
		const record = {
			contactId: contact.id,
			contact,
			intents: [intent],
			entryEvents: [],
		}
		expect(learnerFlowDrillSuppression(record, now)).toMatchObject({
			contactId: contact.id,
			intentId: intent.id,
			fixtureId: fixture!.fixtureId,
		})
		expect(
			learnerFlowDrillSuppression(record, '2026-07-18T08:00:00.000Z'),
		).toBeUndefined()
		expect(
			learnerFlowDrillSuppression(
				{
					...record,
					contact: { ...contact, email: 'learner@example.com' },
				},
				now,
			),
		).toBeUndefined()
	})

	it('deletes every drill fixture and verifies residue by contact id', async () => {
		const repository = new DrillRepository()
		await createLearnerFlowDrillFixtures({
			repository,
			runId: 'run-c',
			scenario: 'drift',
			allowWrite: true,
			now,
		})
		await createLearnerFlowDrillFixtures({
			repository,
			runId: 'run-c',
			scenario: 'zombie',
			allowWrite: true,
			now,
		})
		const result = await cleanupLearnerFlowDrillFixtures({
			repository,
			allowWrite: true,
		})
		expect(result.deleted).toBe(6)
		if (!result.postDeleteReadbacks) {
			throw new Error('Cleanup did not return post-delete readbacks')
		}
		expect(result.postDeleteReadbacks).toHaveLength(6)
		expect(
			result.postDeleteReadbacks.every((item) => item.residue.total === 0),
		).toBe(true)
		expect(repository.contacts.size).toBe(0)
	})

	it('parses only post-induction reconciler receipts and current Pulse evidence', () => {
		const axiom = parseLearnerFlowDrillAxiomOutput(
			JSON.stringify({
				matches: [
					{
						_time: '2026-07-18T00:59:59.000Z',
						payload: { loop: 'reconciler', planned: 0 },
					},
					{
						_time: '2026-07-18T01:30:00.000Z',
						data: {
							payload: {
								loop: 'reconciler',
								planned: 0,
								starved: 3,
							},
						},
					},
					{
						_time: '2026-07-18T01:31:00.000Z',
						payload: { loop: 'executor' },
					},
				],
			}),
			'2026-07-18T01:05:00.000Z',
		)
		expect(axiom).toEqual([
			{
				observedAt: '2026-07-18T01:30:00.000Z',
				payload: { loop: 'reconciler', planned: 0, starved: 3 },
			},
		])

		const pulse = parseLearnerFlowDrillPulseOutput(
			JSON.stringify({
				result: {
					generatedAt: '2026-07-18T01:31:00.000Z',
					sources: {
						liveness: {
							status: 'available',
							current: {
								alarms: [
									{
										id: 'learner-flow-drip-fixture-zero-plan',
										observedAt: '2026-07-18T01:30:00.000Z',
									},
								],
								loops: {
									drip: {
										observedAt: '2026-07-18T01:30:00.000Z',
										identicalRunStreak: 1,
									},
								},
							},
						},
					},
				},
			}),
		)
		expect(pulse).toMatchObject({
			capturedAt: '2026-07-18T01:31:00.000Z',
			dripObservedAt: '2026-07-18T01:30:00.000Z',
			identicalRunStreak: 1,
			alarms: [
				{
					id: 'learner-flow-drip-fixture-zero-plan',
					observedAt: '2026-07-18T01:30:00.000Z',
				},
			],
		})
	})

	it('waits through the remaining suppression window plus one reconciler margin', () => {
		expect(
			zombieHealWaitTimeoutMilliseconds({
				now: '2026-07-18T06:01:00.000Z',
				suppressionExpiresAt: '2026-07-18T08:30:00.000Z',
				observationMarginMilliseconds: 75 * 60 * 1000,
			}),
		).toBe((2 * 60 + 29 + 75) * 60 * 1000)
	})

	it('runs drift then zombie, receipts every gate, and cleans without an operator touch', async () => {
		const repository = new DrillRepository()
		const observations = [
			{
				runs: [
					{
						observedAt: '2026-07-18T02:00:10.000Z',
						payload: {
							repairedCompletionFacts: 3,
							created: 3,
							served: 3,
						},
					},
				],
			},
			{
				runs: [
					{
						observedAt: '2026-07-18T03:00:10.000Z',
						payload: {
							zeroPlanWhileStarved: false,
							planned: 9,
							served: 9,
							suppressedFixtureStarved: 3,
						},
					},
				],
				pulse: {
					capturedAt: '2026-07-18T03:01:00.000Z',
					alarms: [
						{
							id: 'learner-flow-drip-fixture-zero-plan',
							observedAt: '2026-07-18T03:00:10.000Z',
						},
					],
					dripObservedAt: '2026-07-18T03:00:10.000Z',
					identicalRunStreak: 0,
				},
			},
			{
				runs: [
					'2026-07-18T03:00:10.000Z',
					'2026-07-18T04:00:10.000Z',
					'2026-07-18T05:00:10.000Z',
					'2026-07-18T06:00:10.000Z',
				].map((observedAt) => ({
					observedAt,
					payload: {
						planned: 9,
						served: 9,
						suppressedFixtureStarved: 3,
					},
				})),
				pulse: {
					capturedAt: '2026-07-18T06:01:00.000Z',
					alarms: [
						{
							id: 'learner-flow-drip-fixture-identical-payloads',
							observedAt: '2026-07-18T06:00:10.000Z',
						},
					],
					dripObservedAt: '2026-07-18T06:00:10.000Z',
					identicalRunStreak: 0,
				},
			},
			{
				runs: [
					{
						observedAt: '2026-07-18T09:00:10.000Z',
						payload: {
							suppressedFixtureStarved: 0,
							served: 3,
						},
					},
				],
			},
		]
		const phases: string[] = []
		const receiptBodies = new Map<string, Record<string, unknown>>()
		const readbackCalls = { drift: 0, zombie: 0 }
		let currentTime = now
		const result = await runLearnerFlowDrill({
			ports: {
				repository,
				observe: async () => {
					const observation = observations.shift() ?? { runs: [] }
					const observedAt =
						observation.runs.at(-1)?.observedAt ??
						observation.pulse?.capturedAt
					if (observedAt) currentTime = observedAt
					return observation
				},
				readFixtureReadbacks: async (fixtures) => {
					const scenario = fixtures[0]!.scenario
					readbackCalls[scenario] += 1
					const inducedDrift =
						scenario === 'drift' && readbackCalls.drift === 1
					const healed = readbackCalls[scenario] > 1
					return fixtures.map((fixture) => ({
						contactId: fixture.contactId!,
						seedIntentId: fixture.intentId!,
						seedCompletedAt: inducedDrift
							? null
							: '2026-07-17T01:05:00.000Z',
						seedMetadataCompletedAt: inducedDrift
							? null
							: '2026-07-17T01:05:00.000Z',
						nextIntentId: healed ? `${fixture.intentId}-next` : undefined,
						nextIntentStatus: healed ? 'completed' : undefined,
						nextIntentCompletedAt: healed
							? '2026-07-18T09:00:10.000Z'
							: undefined,
					}))
				},
				writeReceipt: async (phase, body) => {
					phases.push(phase)
					receiptBodies.set(phase, body)
					return `/receipts/${phase}.json`
				},
				sleep: async () => undefined,
				now: () => currentTime,
			},
			runId: 'run-e',
			scenario: 'both',
		})
		expect(result.fixtureCounts).toEqual({ drift: 3, zombie: 3 })
		expect(phases).toEqual([
			'drift-induced',
			'drift-detected-and-healed',
			'zombie-induced',
			'zombie-zero-plan-detected',
			'zombie-identical-payload-detected',
			'zombie-healed',
			'cleanup',
		])
		expect(repository.contacts.size).toBe(0)
		expect(receiptBodies.get('zombie-zero-plan-detected')).toMatchObject({
			pulseInvocationAt: '2026-07-18T03:01:00.000Z',
			alarmProofContract: {
				aggregateIncidentBacktest: {
					incidentDate: '2026-07-16',
					pulseCommit: '96143a17',
				},
				busyNightRationaleReceipt:
					'.brain/data/learner-flow/receipts/2026-07-18t05-37-18-000z-learner-flow-drill-zombie-alarm-gate-analysis.json',
			},
		})
		expect(
			receiptBodies.get('zombie-identical-payload-detected'),
		).toMatchObject({
			pulseInvocationAt: '2026-07-18T06:01:00.000Z',
			pulseAlarmEvidence: {
				id: 'learner-flow-drip-fixture-identical-payloads',
			},
		})
	})

	it('cleans persisted drill fixtures when observation fails', async () => {
		const repository = new DrillRepository()
		const phases: string[] = []
		let clock = Date.parse(now)
		await expect(
			runLearnerFlowDrill({
				ports: {
					repository,
					observe: async () => ({
						runs: [
							{
								observedAt: '2026-07-18T02:06:00.000Z',
								payload: {
									repairedCompletionFacts: 3,
									created: 3,
									served: 3,
								},
							},
						],
					}),
					readFixtureReadbacks: async (fixtures) =>
						fixtures.map((fixture) => ({
							contactId: fixture.contactId!,
							seedIntentId: fixture.intentId!,
							seedCompletedAt: null,
							seedMetadataCompletedAt: null,
						})),
					writeReceipt: async (phase) => {
						phases.push(phase)
						return `/receipts/${phase}.json`
					},
					sleep: async (milliseconds) => {
						clock += milliseconds
					},
					now: () => new Date(clock).toISOString(),
				},
				runId: 'run-f',
				scenario: 'drift',
				pollMilliseconds: 2,
				observationTimeoutMilliseconds: 1,
			}),
		).rejects.toThrow('Timed out waiting for learner-flow drill evidence')
		expect(phases).toEqual(['drift-induced', 'failed', 'cleanup'])
		expect(repository.contacts.size).toBe(0)
	})

	it('models both scenarios through cleanup as one explicit lifecycle', () => {
		const actor = createActor(learnerFlowDrillMachine, {
			input: { runId: 'run-d', scenario: 'both' },
		})
		actor.start()
		for (const event of [
			{ type: 'START' as const },
			{ type: 'DRIFT_INDUCED' as const },
			{ type: 'DRIFT_HEALED' as const },
			{ type: 'ZOMBIE_INDUCED' as const },
			{ type: 'ZERO_PLAN_DETECTED' as const },
			{ type: 'IDENTICAL_PAYLOAD_DETECTED' as const },
			{ type: 'ZOMBIE_HEALED' as const },
			{ type: 'CLEANED' as const },
		]) {
			actor.send(event)
		}
		expect(actor.getSnapshot().status).toBe('done')
		actor.stop()
	})
})
