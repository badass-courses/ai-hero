import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

import { codingWorkflowFixture } from './__fixtures__/quick-question-fixtures'
import {
	dryRunSubscriberMarketingFixture,
	InMemorySubscriberMarketingRepository,
} from './dry-run'
import type { LearnerFlowCohortRecord } from './learner-flow-cohort'
import { classifyLearnerFlowContact } from './learner-flow-classifier'
import {
	buildLearnerFlowReconcilerPlan,
	evaluateLearnerFlowReconcilerBrake,
	LEARNER_FLOW_RECONCILER_CONFIG,
	reconcileLearnerFlow,
	type LearnerFlowReconcilerRepository,
} from './learner-flow-reconciler'
import type {
	ContactEventRecord,
	ContactRecord,
	ContactState,
	NextAction,
	ProviderIdentityRecord,
	SideEffectIntent,
} from './types'
import type { GateDRuntimeAllowlist } from './value-path-gate-d-allowlist'
import { progressValuePathDrips } from './value-path-drip-progression'

const now = '2026-07-17T23:00:00.000Z'

function courseIntent(args: {
	contactId: string
	id: string
	status?: SideEffectIntent['status']
	createdAt?: string
	completedAt?: string
	cadenceHours?: number
	emailResourceId?: string
	kitSequenceId?: string
}): SideEffectIntent {
	return {
		id: args.id,
		nextActionId: `${args.id}-action`,
		contactId: args.contactId,
		provider: 'kit',
		type: 'send-value-path-email',
		status: args.status ?? 'pending',
		idempotencyKey: `${args.contactId}:${args.id}`,
		gates: [],
		reviewReasons: [],
		metadata: {
			valuePathSlug: 'ai-hero-skills-workflow',
			emailResourceId:
				args.emailResourceId ?? 'ai-hero-skills-workflow.email-0',
			kitSequenceId: args.kitSequenceId ?? '2757199',
			...(args.completedAt ? { completedAt: args.completedAt } : {}),
			...(args.cadenceHours
				? {
						learnerFlowCanary: true,
						learnerFlowCanaryCadenceHours: args.cadenceHours,
					}
				: {}),
		},
		createdAt: args.createdAt ?? now,
		completedAt: args.completedAt,
	}
}

function rollingAllowlist(): GateDRuntimeAllowlist {
	return {
		activationId: 'reconciler-test',
		status: 'active',
		killSwitch: false,
		mode: 'scoped-live',
		authorizationMode: 'rolling-public-enrollment',
		pathSlugs: ['ai-hero-skills-workflow'],
		contactIds: [],
		kitSubscriberIds: [],
		emails: [],
		emailHashes: [],
		emailResourceIds: [
			'ai-hero-skills-workflow.email-0',
			'ai-hero-skills-workflow.email-1',
		],
		kitSequenceIds: ['2757199', '2757200'],
		candidates: [],
		allowedActions: ['advance-by-daily-drip', 'send-path-emails'],
		createdAt: now,
	}
}

class BrakeOnlyRepository implements LearnerFlowReconcilerRepository {
	writeAttempts = 0
	includeCanary: boolean | undefined

	constructor(private readonly records: LearnerFlowCohortRecord[]) {}

	findSkillsWorkflowLearnerFlowRecords(options?: { includeCanary?: boolean }) {
		this.includeCanary = options?.includeCanary
		return this.records
	}

	newId() {
		return 'never'
	}
	findContactById(): ContactRecord | undefined {
		return undefined
	}
	findCurrentContactState(): ContactState | undefined {
		return undefined
	}
	findProviderIdentity(): ProviderIdentityRecord | undefined {
		return undefined
	}
	createProviderIdentity(): ProviderIdentityRecord {
		this.writeAttempts += 1
		throw new Error('brake allowed a provider identity write')
	}
	findContactEventBySemanticKey(): ContactEventRecord | undefined {
		return undefined
	}
	createContactEvent(): ContactEventRecord {
		this.writeAttempts += 1
		throw new Error('brake allowed a contact event write')
	}
	createNextAction(): NextAction {
		this.writeAttempts += 1
		throw new Error('brake allowed a next action write')
	}
	findSideEffectIntentByIdempotencyKey(): SideEffectIntent | undefined {
		return undefined
	}
	createSideEffectIntent(): SideEffectIntent {
		this.writeAttempts += 1
		throw new Error('brake allowed an intent write')
	}
	findPendingValuePathEmailSideEffectIntents(): SideEffectIntent[] {
		return []
	}
	findValuePathEmailSideEffectIntentsByContact(): SideEffectIntent[] {
		return []
	}
	updateSideEffectIntent(): SideEffectIntent {
		this.writeAttempts += 1
		throw new Error('brake allowed an intent update')
	}
}

describe('learner flow reconciler', () => {
	it('uses the classifier cadence decision for normal and accelerated canary learners', () => {
		const normal = classifyLearnerFlowContact({
			contactId: 'normal',
			intents: [
				courseIntent({
					contactId: 'normal',
					id: 'normal-0',
					status: 'completed',
					completedAt: '2026-07-16T22:00:00.000Z',
				}),
			],
			now,
		})
		const canary = classifyLearnerFlowContact({
			contactId: 'canary',
			intents: [
				courseIntent({
					contactId: 'canary',
					id: 'canary-0',
					status: 'completed',
					completedAt: '2026-07-17T21:00:00.000Z',
					cadenceHours: 1,
				}),
			],
			now,
		})
		expect(normal).toMatchObject({
			state: 'stuck',
			cause: 'drip-starved',
			intentId: 'normal-0',
		})
		expect(canary).toMatchObject({
			state: 'stuck',
			cause: 'drip-starved',
			intentId: 'canary-0',
		})
	})

	it('plans the existing-finisher email-7 wave as normal reconciler work', async () => {
		const records = Array.from({ length: 300 }, (_, index) => {
			const contactId = `contact-${index}`
			return {
				contactId,
				entryEvents: [],
				intents: [
					courseIntent({
						contactId,
						id: `intent-${index}`,
						status: index < 60 ? 'completed' : 'pending',
						completedAt:
							index < 60 ? '2026-07-16T20:00:00.000Z' : undefined,
						emailResourceId:
							index < 60
								? 'ai-hero-skills-workflow.email-6'
								: 'ai-hero-skills-workflow.email-0',
						kitSequenceId: index < 60 ? '2757205' : '2757199',
					}),
				],
			}
		})
		const plan = await buildLearnerFlowReconcilerPlan({
			repository: new BrakeOnlyRepository(records),
			allowlist: rollingAllowlist(),
			now,
		})
		expect(plan.counts).toMatchObject({ planned: 60, stuck: 60 })
		expect(plan.candidates).toHaveLength(60)
		expect(plan.candidates[0]).toMatchObject({
			action: 'nudge-drip-progression',
			stage: 'ai-hero-skills-workflow.email-6',
		})
		expect(
			evaluateLearnerFlowReconcilerBrake({
				planned: plan.counts.planned,
				cohortSize: plan.cohort.contacts,
			}),
		).toMatchObject({ status: 'clear', cap: 150 })
	})

	it('does not brake a healthy big day that exceeds the cap (2026-07-18 incident)', () => {
		// 172 planned for 1,006 learners = 17.1%, under the 25% wall. The cap
		// slice serves 150 oldest-first and defers 22; braking here stalled 172
		// real learners for an hour.
		expect(
			evaluateLearnerFlowReconcilerBrake({ planned: 172, cohortSize: 1006 }),
		).toMatchObject({ status: 'clear', cap: 150 })
		expect(
			evaluateLearnerFlowReconcilerBrake({ planned: 300, cohortSize: 1006 }),
		).toMatchObject({ status: 'tripped' })
	})

	it('brakes the 313 false-stuck wolf before every write', async () => {
		const records = Array.from({ length: 830 }, (_, index) => {
			const contactId = `contact-${index}`
			let status: SideEffectIntent['status'] = 'pending'
			if (index < 313) status = 'blocked'
			if (index === 829) status = 'failed'
			const intent = courseIntent({
				contactId,
				id: `intent-${index}`,
				status,
			})
			return {
				contactId,
				entryEvents: [],
				intents: [
					index === 829
						? { ...intent, metadata: { ...intent.metadata, retryable: false } }
						: intent,
				],
			}
		})
		const repository = new BrakeOnlyRepository(records)
		let providerWrites = 0
		const receipt = await reconcileLearnerFlow({
			repository,
			allowlist: rollingAllowlist(),
			emailListProvider: {
				subscribeToList: async () => {
					providerWrites += 1
					return { success: true }
				},
			},
			executorConfig: {},
			now,
		})
		expect(receipt).toMatchObject({
			brake: 'tripped',
			workSeen: 313,
			workDone: 0,
			deferred: 313,
			tier2: 1,
			dmPriority: 'high',
		})
		expect(receipt.dmLine).toContain('failed-send=1')
		expect(receipt.brakeReasons).toContain(
			'planned-ratio-37.7%-exceeds-25.0%',
		)
		expect(receipt.plannedToCohortRatio).toBeCloseTo(313 / 830)
		expect(repository.includeCanary).toBe(true)
		expect(repository.writeAttempts).toBe(0)
		expect(providerWrites).toBe(0)
	})

	it('repairs a completed drift fixture with both stamps absent, then serves its next step', async () => {
		const repository = new InMemorySubscriberMarketingRepository()
		const captured = await dryRunSubscriberMarketingFixture({
			repository,
			fixture: codingWorkflowFixture,
			now: '2026-07-15T20:00:00.000Z',
		})
		repository.sideEffectIntents.clear()
		const driftIntent: SideEffectIntent = {
			...courseIntent({
				contactId: captured.contact.id,
				id: 'drift-email-0',
				status: 'completed',
				createdAt: '2026-07-15T20:00:00.000Z',
			}),
			completedAt: null,
			metadata: {
				valuePathSlug: 'ai-hero-skills-workflow',
				emailResourceId: 'ai-hero-skills-workflow.email-0',
				kitSequenceId: '2757199',
				kitSubscriberId: '4089521940',
				providerCompletedAt: '2026-07-15T20:00:00.000Z',
				learnerFlowFixture: true,
				learnerFlowFixtureId: 'drill-drift-v1-test-1',
				learnerFlowFixtureStatus: 'active',
				learnerFlowDrill: true,
				learnerFlowDrillScenario: 'drift',
			},
		}
		repository.sideEffectIntents.set(driftIntent.id, driftIntent)
		const reconcilerRepository = Object.assign(repository, {
			findSkillsWorkflowLearnerFlowRecords: () => [
				{
					contactId: captured.contact.id,
					contact: captured.contact,
					contactState: captured.contactState,
					intents: Array.from(repository.sideEffectIntents.values()),
					entryEvents: [],
				},
			],
		})
		const allowlist = rollingAllowlist()
		expect(allowlist.contactIds).toEqual([])
		expect(allowlist.kitSubscriberIds).toEqual([])
		expect(allowlist.emails).toEqual([])
		const plan = await buildLearnerFlowReconcilerPlan({
			repository: reconcilerRepository,
			allowlist,
			now,
		})
		expect(plan.candidates).toMatchObject([
			{
				action: 'repair-completion-and-nudge-drip',
				intentId: driftIntent.id,
			},
		])
		expect(plan.tier2).toHaveLength(0)

		const receipt = await reconcileLearnerFlow({
			repository: reconcilerRepository,
			allowlist,
			emailListProvider: {
				subscribeToList: async () => ({ success: true }),
			},
			executorConfig: {
				mode: 'scoped-live',
				baseUrl: 'https://www.aihero.dev',
				pathTokenSecret: 'test-secret',
				answerPages: [
					{
						id: 'answer-email-1',
						type: 'value-path-page',
						fields: {
							kind: 'answer',
							slug: 'answer-email-1',
							sequenceId: 'ai-hero-skills-workflow',
							emailId: 'email-1',
							optionValue: 'continue',
						},
					},
				],
				allowlistedContactIds: [],
				allowlistedKitSubscriberIds: [],
				allowlistedEmails: [],
				enabledValuePathSlugs: ['ai-hero-skills-workflow'],
				verifiedEmailResourceIds: [
					'ai-hero-skills-workflow.email-1',
				],
				verifiedKitSequenceIds: ['2757200'],
				allowedActions: ['send-path-emails'],
			},
			now,
			config: {
				sendCap: 150,
				maxPlannedToCohortRatio: 1,
			},
		})
		const repaired = repository.sideEffectIntents.get(driftIntent.id)!
		const next = Array.from(repository.sideEffectIntents.values()).find(
			(intent) =>
				intent.metadata.emailResourceId ===
				'ai-hero-skills-workflow.email-1',
		)
		expect(driftIntent.completedAt).toBeNull()
		expect(driftIntent.metadata.completedAt).toBeUndefined()
		expect(repaired.completedAt).toBe('2026-07-15T20:00:00.000Z')
		expect(repaired.metadata.completedAt).toBe(
			'2026-07-15T20:00:00.000Z',
		)
		expect(next?.status).toBe('completed')
		expect(receipt).toMatchObject({
			brake: 'clear',
			repairedCompletionFacts: 1,
			created: 1,
			served: 1,
			starved: 1,
		})
	})

	it('counts fixture-scoped zombie suppression as starvation without planning it', async () => {
		const completedAt = '2026-07-15T20:00:00.000Z'
		const intent = {
			...courseIntent({
				contactId: 'zombie-contact',
				id: 'zombie-email-0',
				status: 'completed',
				completedAt,
			}),
			metadata: {
				valuePathSlug: 'ai-hero-skills-workflow',
				emailResourceId: 'ai-hero-skills-workflow.email-0',
				kitSequenceId: '2757199',
				completedAt,
				providerCompletedAt: completedAt,
				learnerFlowFixture: true,
				learnerFlowFixtureId: 'drill-zombie-v1-test-1',
				learnerFlowFixtureStatus: 'active',
				learnerFlowDrill: true,
				learnerFlowDrillScenario: 'zombie',
				learnerFlowDrillSuppressedUntil: '2026-07-18T05:30:00.000Z',
			},
		}
		const repository = new BrakeOnlyRepository([
			{
				contactId: 'zombie-contact',
				contact: {
					id: 'zombie-contact',
					email:
						'joel+aih-synth-drill-zombie-v1-test-1@badass.dev',
					lifecycle: 'nurture-ready',
					isProvisional: true,
					createdAt: completedAt,
					updatedAt: completedAt,
				},
				intents: [intent],
				entryEvents: [],
			},
		])
		const plan = await buildLearnerFlowReconcilerPlan({
			repository,
			allowlist: rollingAllowlist(),
			now,
		})
		expect(plan.counts).toMatchObject({
			planned: 0,
			suppressedFixtureStarved: 1,
		})
		const receipt = await reconcileLearnerFlow({
			repository,
			allowlist: rollingAllowlist(),
			emailListProvider: {
				subscribeToList: async () => ({ success: true }),
			},
			executorConfig: {},
			now,
		})
		expect(receipt).toMatchObject({
			workSeen: 1,
			workDone: 0,
			planned: 0,
			starved: 1,
			suppressedFixtureStarved: 1,
			zeroPlanWhileStarved: true,
		})
		expect(repository.writeAttempts).toBe(0)
	})

	it('uses the existing intent idempotency key when an Inngest step retries after create', async () => {
		const repository = new InMemorySubscriberMarketingRepository()
		const captured = await dryRunSubscriberMarketingFixture({
			repository,
			fixture: codingWorkflowFixture,
			now: '2026-07-15T20:00:00.000Z',
		})
		const completed = repository.createSideEffectIntent({
			...courseIntent({
				contactId: captured.contact.id,
				id: 'completed-email-0',
				status: 'completed',
				completedAt: '2026-07-15T20:00:00.000Z',
			}),
			idempotencyKey: `contact:${captured.contact.id}:value-path:ai-hero-skills-workflow:email:ai-hero-skills-workflow.email-0`,
			metadata: {
				valuePathSlug: 'ai-hero-skills-workflow',
				emailResourceId: 'ai-hero-skills-workflow.email-0',
				kitSequenceId: '2757199',
				kitSubscriberId: '4089521940',
				completedAt: '2026-07-15T20:00:00.000Z',
			},
		})
		const allowlist = {
			...rollingAllowlist(),
			contactIds: [captured.contact.id],
			kitSubscriberIds: ['4089521940'],
			emails: [captured.contact.email!],
		}
		const first = await progressValuePathDrips({
			repository,
			allowlist,
			completedIntents: [completed],
			allowWrite: true,
			now: '2026-07-17T23:00:00.000Z',
		})
		const retriedStep = await progressValuePathDrips({
			repository,
			allowlist,
			completedIntents: [completed],
			allowWrite: true,
			now: '2026-07-17T23:00:00.000Z',
		})
		expect(first.counts.planned).toBe(1)
		expect(retriedStep.counts.idempotentNoop).toBe(1)
		expect(
			Array.from(repository.sideEffectIntents.values()).filter(
				(intent) =>
					intent.metadata.emailResourceId === 'ai-hero-skills-workflow.email-1',
			),
		).toHaveLength(1)
	})

	it('registers one hourly reconciler and removes the old hourly planner binding', async () => {
		const [functionSource, configSource] = await Promise.all([
			readFile(
				new URL(
					'../../inngest/functions/learner-flow-reconciler.ts',
					import.meta.url,
				),
				'utf8',
			),
			readFile(
				new URL('../../inngest/inngest.config.ts', import.meta.url),
				'utf8',
			),
		])
		expect(functionSource).toMatch(/id: ["']learner-flow-reconciler["']/u)
		expect(functionSource).toMatch(/cron: ["']0 \* \* \* \*["']/u)
		expect(functionSource).toContain('concurrency: 1')
		expect(configSource).toContain('learnerFlowReconciler')
		expect(configSource).not.toContain('valuePathDripProgression')
	})
})
