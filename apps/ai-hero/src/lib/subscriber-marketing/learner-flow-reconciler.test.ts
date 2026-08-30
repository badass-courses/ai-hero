import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

import { codingWorkflowFixture } from './__fixtures__/quick-question-fixtures'
import {
	EMAIL_COURSE_ENTRY_PAYLOAD_FORMAT,
	deadlineTimeZoneEvidenceFromHeader,
} from './course-sequence-exhaustion'
import { DrizzleCaptureMarketingRepository } from './drizzle-capture-repository'
import {
	dryRunSubscriberMarketingFixture,
	InMemorySubscriberMarketingRepository,
} from './dry-run'
import type { LearnerFlowCohortRecord } from './learner-flow-cohort'
import { classifyLearnerFlowContact } from './learner-flow-classifier'
import {
	buildLearnerFlowReconcilerPlan,
	evaluateLearnerFlowReconcilerBrake,
	reconcileLearnerFlow,
	type LearnerFlowReconcilerCandidate,
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

function riskyReplanCandidates(count: number): LearnerFlowReconcilerCandidate[] {
	return Array.from({ length: count }, (_, index) => ({
		contactId: `contact-${index}`,
		intentId: `intent-${index}`,
		action: 'replan-blocked-intent',
		cause: 'blocked-intent',
		stage: 'ai-hero-skills-workflow.email-2',
		lastActivityAt: now,
	}))
}

function emailSevenAllowlist(): GateDRuntimeAllowlist {
	return {
		...rollingAllowlist(),
		emailResourceIds: [
			'ai-hero-skills-workflow.email-1',
			'ai-hero-skills-workflow.email-7',
		],
		kitSequenceIds: ['2757200', '2831545'],
	}
}

async function createEmailSixReconcilerFixture() {
	const repository = new InMemorySubscriberMarketingRepository()
	const captured = await dryRunSubscriberMarketingFixture({
		repository,
		fixture: codingWorkflowFixture,
		now: '2026-07-15T20:00:00.000Z',
	})
	repository.sideEffectIntents.clear()
	const deadline = deadlineTimeZoneEvidenceFromHeader({
		headerValue: 'Asia/Tokyo',
		capturedAt: '2026-07-15T20:00:00.000Z',
	})
	if (!deadline.ok) throw new Error(deadline.error.detail)
	const courseEntry = repository.createContactEvent({
		contactId: captured.contact.id,
		providerIdentityId: captured.providerIdentity.id,
		provider: 'ai-hero',
		providerEventId: `course-entry:${captured.contact.id}`,
		providerReference: 'value-path:ai-hero-skills-workflow',
		eventType: 'value-path.entered',
		occurredAt: '2026-07-15T20:00:00.000Z',
		semanticIdempotencyKey: `course-entry:${captured.contact.id}`,
		payloadFormat: EMAIL_COURSE_ENTRY_PAYLOAD_FORMAT,
		domainPayload: {
			format: EMAIL_COURSE_ENTRY_PAYLOAD_FORMAT,
			valuePathId: 'ai-hero-skills-workflow',
			emailResourceId: 'ai-hero-skills-workflow.email-0',
			deadlineTimeZone: deadline.value,
		},
		privacyLevel: 'internal',
		identityEvidence: captured.providerIdentity.evidence,
		payloadSummary: {
			summary: 'Entered AI Hero Skills Workflow',
			keywords: ['value-path', 'entered'],
			restrictedPayloadStored: false,
		},
		schemaVersion: 1,
		createdAt: '2026-07-15T20:00:00.000Z',
	})
	const completed = repository.createSideEffectIntent({
		...courseIntent({
			contactId: captured.contact.id,
			id: 'completed-email-6',
			status: 'completed',
			completedAt: '2026-07-15T20:00:00.000Z',
			emailResourceId: 'ai-hero-skills-workflow.email-6',
			kitSequenceId: '2757205',
		}),
		metadata: {
			valuePathSlug: 'ai-hero-skills-workflow',
			emailResourceId: 'ai-hero-skills-workflow.email-6',
			kitSequenceId: '2757205',
			kitSubscriberId: '4089521940',
			completedAt: '2026-07-15T20:00:00.000Z',
			courseEntryEventId: courseEntry.id,
			courseDeadlineTimeZone: deadline.value,
		},
	})
	const reconcilerRepository = Object.assign(repository, {
		findSkillsWorkflowLearnerFlowRecords: () => [
			{
				contactId: captured.contact.id,
				contact: captured.contact,
				contactState: captured.contactState,
				intents: [completed],
				entryEvents: [],
			},
		],
	})
	return { captured, completed, reconcilerRepository, repository }
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
				cohortSize: plan.cohort.contacts,
				candidates: plan.candidates,
			}),
		).toMatchObject({ status: 'clear', repairCap: 150 })
	})

	it('keeps the repair ratio brake below the evidence-backed wall', () => {
		expect(
			evaluateLearnerFlowReconcilerBrake({
				cohortSize: 1006,
				candidates: riskyReplanCandidates(172),
			}),
		).toMatchObject({ status: 'clear', repairCap: 150 })
		expect(
			evaluateLearnerFlowReconcilerBrake({
				cohortSize: 1006,
				candidates: riskyReplanCandidates(300),
			}),
		).toMatchObject({ status: 'tripped' })
	})

	it('does not ratio-brake a large routine drip backlog', () => {
		const candidates = Array.from({ length: 456 }, (_, index) => ({
			contactId: `contact-${index}`,
			intentId: `intent-${index}`,
			action: 'nudge-drip-progression' as const,
			cause: 'drip-starved' as const,
			stage: 'ai-hero-skills-workflow.email-6',
			lastActivityAt: now,
		})) satisfies LearnerFlowReconcilerCandidate[]

		expect(
			evaluateLearnerFlowReconcilerBrake({
				cohortSize: 1028,
				candidates,
			}),
		).toMatchObject({
			status: 'clear',
			repairToCohortRatio: 0,
			repairCap: 150,
		})
	})

	it('ratio-brakes a large risky replan anomaly', () => {
		const candidates = riskyReplanCandidates(300)

		expect(
			evaluateLearnerFlowReconcilerBrake({
				cohortSize: 1000,
				candidates,
			}),
		).toMatchObject({
			status: 'tripped',
			repairToCohortRatio: 0.3,
		})
	})

	it('queues email-7 from email-6 when the live flag is enabled', async () => {
		const { reconcilerRepository, repository } =
			await createEmailSixReconcilerFixture()
		const receipt = await reconcileLearnerFlow({
			repository: reconcilerRepository,
			allowlist: emailSevenAllowlist(),
			email7LiveEnabled: true,
			now,
			config: { repairCap: 150, maxRepairToCohortRatio: 1 },
		})
		const emailSeven = Array.from(repository.sideEffectIntents.values()).find(
			(intent) =>
				intent.metadata.emailResourceId ===
				'ai-hero-skills-workflow.email-7',
		)

		expect(emailSeven).toMatchObject({ status: 'pending' })
		expect(
			Array.from(repository.contactEvents.values()).some(
				(event) => event.eventType === 'course.sequence-exhausted',
			),
		).toBe(false)
		expect(receipt).toMatchObject({
			status: 'ok',
			workSeen: 1,
			workDone: 1,
			counts: {
				intentsCreated: 1,
				noop: 0,
				blocked: 0,
				notDue: 0,
				failed: 0,
			},
			blockedReasons: {},
		})
	})

	it('atomically owns sequence exhaustion when terminal Email 7 is committed', async () => {
		const { completed, reconcilerRepository, repository } =
			await createEmailSixReconcilerFixture()
		const first = await reconcileLearnerFlow({
			repository: reconcilerRepository,
			allowlist: emailSevenAllowlist(),
			email7LiveEnabled: true,
			sequenceExhaustionEnabled: true,
			now,
			config: { repairCap: 150, maxRepairToCohortRatio: 1 },
		})
		const second = await progressValuePathDrips({
			repository,
			allowlist: emailSevenAllowlist(),
			completedIntents: [completed],
			allowWrite: true,
			email7LiveEnabled: true,
			sequenceExhaustionEnabled: true,
			now,
		})
		const facts = Array.from(repository.contactEvents.values()).filter(
			(event) => event.eventType === 'course.sequence-exhausted',
		)
		const intents = Array.from(repository.sideEffectIntents.values()).filter(
			(intent) =>
				intent.metadata.emailResourceId ===
				'ai-hero-skills-workflow.email-7',
		)

		expect(first.counts.intentsCreated).toBe(1)
		expect(second.counts.idempotentNoop).toBe(1)
		expect(second.results[0]).toMatchObject({
			contactEventId: facts[0]?.id,
			nextActionId: intents[0]?.nextActionId,
			sideEffectIntentId: intents[0]?.id,
		})
		expect(facts).toHaveLength(1)
		expect(intents).toHaveLength(1)
		expect(facts[0]).toMatchObject({
			domainFactKey: expect.stringContaining('email-course.sequence-exhausted'),
			payloadFormat: 'email-course.sequence-exhausted.v1',
			domainPayload: {
				deadlineTimeZone: {
					type: 'BrowserEntryHeader',
					timeZone: 'Asia/Tokyo',
				},
				progression: {
					from: { emailResourceId: 'ai-hero-skills-workflow.email-6' },
					terminal: {
						emailResourceId: 'ai-hero-skills-workflow.email-7',
					},
				},
			},
		})
		expect(intents[0]).toMatchObject({
			status: 'pending',
			metadata: {
				sequenceExhaustionFactId: facts[0]?.id,
				providerResult: null,
			},
		})
		expect(repository.nextActions.get(intents[0]!.nextActionId)?.eventId).toBe(
			facts[0]?.id,
		)
		repository.updateSideEffectIntent(intents[0]!.id, {
			status: 'completed',
			completedAt: '2026-07-18T00:00:00.000Z',
			gates: intents[0]!.gates,
			reviewReasons: [],
			metadata: {
				...intents[0]!.metadata,
				providerResult: { status: 'accepted' },
			},
		})
		const afterSettlement = await progressValuePathDrips({
			repository,
			allowlist: emailSevenAllowlist(),
			completedIntents: [completed],
			allowWrite: true,
			email7LiveEnabled: true,
			sequenceExhaustionEnabled: true,
			now,
		})
		expect(afterSettlement.counts.idempotentNoop).toBe(1)
		expect(afterSettlement.results[0]).toMatchObject({
			contactEventId: facts[0]?.id,
			nextActionId: intents[0]?.nextActionId,
			sideEffectIntentId: intents[0]?.id,
		})
		expect(
			Array.from(repository.contactEvents.values()).filter(
				(event) => event.eventType === 'course.sequence-exhausted',
			),
		).toHaveLength(1)
	})

	it('does not backfill an existing terminal intent into an exhaustion fact', async () => {
		const { reconcilerRepository, repository, captured } =
			await createEmailSixReconcilerFixture()
		repository.createSideEffectIntent({
			...courseIntent({
				contactId: captured.contact.id,
				id: 'historical-email-7',
				status: 'completed',
				completedAt: '2026-07-16T20:00:00.000Z',
				emailResourceId: 'ai-hero-skills-workflow.email-7',
				kitSequenceId: '2831545',
			}),
			idempotencyKey: `contact:${captured.contact.id}:value-path:ai-hero-skills-workflow:email:ai-hero-skills-workflow.email-7`,
		})
		await reconcileLearnerFlow({
			repository: reconcilerRepository,
			allowlist: emailSevenAllowlist(),
			email7LiveEnabled: true,
			sequenceExhaustionEnabled: true,
			now,
			config: { repairCap: 150, maxRepairToCohortRatio: 1 },
		})

		expect(
			Array.from(repository.contactEvents.values()).some(
				(event) => event.eventType === 'course.sequence-exhausted',
			),
		).toBe(false)
	})

	it('reports the exact email-7 blocker when the live flag is disabled', async () => {
		const { reconcilerRepository, repository } =
			await createEmailSixReconcilerFixture()
		const receipt = await reconcileLearnerFlow({
			repository: reconcilerRepository,
			allowlist: emailSevenAllowlist(),
			email7LiveEnabled: false,
			now,
			config: { repairCap: 150, maxRepairToCohortRatio: 1 },
		})

		expect(
			Array.from(repository.sideEffectIntents.values()).some(
				(intent) =>
					intent.metadata.emailResourceId ===
					'ai-hero-skills-workflow.email-7',
			),
		).toBe(false)
		expect(receipt).toMatchObject({
			status: 'degraded',
			workSeen: 1,
			workDone: 0,
			counts: {
				intentsCreated: 0,
				deferred: 1,
				noop: 0,
				blocked: 1,
				notDue: 0,
				failed: 0,
			},
			blockedReasons: { 'email-7-copy-approval-required': 1 },
		})
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
		const receipt = await reconcileLearnerFlow({
			repository,
			allowlist: rollingAllowlist(),
			email7LiveEnabled: false,
			now,
		})
		expect(receipt).toMatchObject({
			receiptVersion: 2,
			loop: 'repair',
			status: 'blocked',
			brake: { status: 'tripped' },
			workSeen: 313,
			workDone: 0,
			counts: {
				deferred: 313,
				tier2: 1,
				permanentProviderFailures: 1,
			},
		})
		expect(receipt.failureReasons).toContain(
			'tier2:provider-permanent-failure',
		)
		expect(receipt.brake.reasons).toContain(
			'repair-ratio-37.7%-exceeds-25.0%',
		)
		expect(repository.includeCanary).toBe(true)
		expect(repository.writeAttempts).toBe(0)
	})

	it('repairs drift and queues the next pending intent without a provider call', async () => {
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
			email7LiveEnabled: true,
			now,
			config: {
				repairCap: 1,
				maxRepairToCohortRatio: 1,
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
		expect(next?.status).toBe('pending')
		expect(receipt).toMatchObject({
			status: 'ok',
			brake: { status: 'clear' },
			workSeen: 1,
			workDone: 1,
			counts: {
				completionFactsRepaired: 1,
				intentsCreated: 1,
			},
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
			email7LiveEnabled: false,
			now,
		})
		expect(receipt).toMatchObject({
			workSeen: 0,
			workDone: 0,
			status: 'ok',
			counts: { intentsCreated: 0 },
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

	it('treats an existing semantic event as proof that a raced insert already completed', async () => {
		const existing = {
			id: 'existing-event',
			contactId: 'contact-1',
			providerIdentityId: 'identity-1',
			provider: 'ai-hero' as const,
			providerEventId: 'event-key',
			providerReference: 'value-path:ai-hero-skills-workflow',
			eventType: 'value-path.drip-progressed',
			semanticIdempotencyKey: 'event-key',
			privacyLevel: 'internal' as const,
			identityEvidence: {
				source: 'ai-hero' as const,
				strength: 'strong' as const,
			},
			payloadSummary: {
				summary: 'existing event',
				keywords: ['value-path'],
				restrictedPayloadStored: false as const,
			},
			schemaVersion: 1 as const,
			occurredAt: new Date(now),
			createdAt: new Date(now),
		}
		const database = {
			insert: () => ({
				values: async () => {
					throw new Error(
						"Duplicate entry 'event-key' for key 'ContactEvent_semanticIdempotencyKey_uq'",
					)
				},
			}),
			select: () => ({
				from: () => ({
					where: () => ({ limit: async () => [existing] }),
				}),
			}),
		}
		const repository = new DrizzleCaptureMarketingRepository(database)

		await expect(
			repository.createContactEvent({
				contactId: existing.contactId,
				providerIdentityId: existing.providerIdentityId,
				provider: existing.provider,
				providerEventId: existing.providerEventId,
				providerReference: existing.providerReference,
				eventType: existing.eventType,
				semanticIdempotencyKey: existing.semanticIdempotencyKey,
				privacyLevel: existing.privacyLevel,
				identityEvidence: existing.identityEvidence,
				payloadSummary: existing.payloadSummary,
				schemaVersion: existing.schemaVersion,
				occurredAt: now,
				createdAt: now,
			}),
		).resolves.toMatchObject({
			id: existing.id,
			semanticIdempotencyKey: existing.semanticIdempotencyKey,
		})
	})

	it('leaves deferred learner work for the executor instead of sending inline', async () => {
		const repository = new InMemorySubscriberMarketingRepository()
		const first = await dryRunSubscriberMarketingFixture({
			repository,
			fixture: codingWorkflowFixture,
			now: '2026-07-15T20:00:00.000Z',
		})
		const second = await dryRunSubscriberMarketingFixture({
			repository,
			fixture: {
				...codingWorkflowFixture,
				providerEventId: 'fixture-event-002',
				externalId: 'fixture-contact-002',
				email: 'second@example.com',
			},
			now: '2026-07-15T20:00:00.000Z',
		})
		const completed = [first, second].map((captured, index) =>
			repository.createSideEffectIntent({
				...courseIntent({
					contactId: captured.contact.id,
					id: `completed-email-0-${index}`,
					status: 'completed',
					completedAt: '2026-07-15T20:00:00.000Z',
				}),
				idempotencyKey: `contact:${captured.contact.id}:value-path:ai-hero-skills-workflow:email:ai-hero-skills-workflow.email-0`,
				metadata: {
					valuePathSlug: 'ai-hero-skills-workflow',
					emailResourceId: 'ai-hero-skills-workflow.email-0',
					kitSequenceId: '2757199',
					kitSubscriberId: `kit-${index}`,
					completedAt: '2026-07-15T20:00:00.000Z',
				},
			}),
		)
		const createContactEvent = repository.createContactEvent.bind(repository)
		repository.createContactEvent = (input) => {
			if (input.contactId === first.contact.id) {
				throw new Error('simulated per-learner write failure')
			}
			return createContactEvent(input)
		}
		const allowlist = {
			...rollingAllowlist(),
			contactIds: [first.contact.id, second.contact.id],
			kitSubscriberIds: ['kit-0', 'kit-1'],
			emails: [first.contact.email!, second.contact.email!],
		}
		const warnings: Array<Record<string, unknown>> = []
		const logger = {
			info: async () => undefined,
			warn: async (_event: string, fields: Record<string, unknown>) => {
				warnings.push(fields)
			},
		}
		const result = await progressValuePathDrips({
			repository,
			allowlist,
			completedIntents: completed,
			allowWrite: true,
			now,
			logger,
		})

		expect(result.counts).toMatchObject({ planned: 1, deferred: 1 })
		expect(result.results.map((item) => item.status)).toEqual([
			'deferred',
			'planned',
		])
		expect(warnings).toMatchObject([
			{
				errorCategory: 'write-failed',
				fromEmailResourceId: 'ai-hero-skills-workflow.email-0',
			},
		])

		const reconcilerRepository = Object.assign(repository, {
			findSkillsWorkflowLearnerFlowRecords: () =>
				[first, second].map((captured) => ({
					contactId: captured.contact.id,
					contact: captured.contact,
					contactState: repository.findCurrentContactState(captured.contact.id),
					intents: repository.findValuePathEmailSideEffectIntentsByContact(
						captured.contact.id,
					),
					entryEvents: [],
				})),
		})
		const receipt = await reconcileLearnerFlow({
			repository: reconcilerRepository,
			allowlist,
			email7LiveEnabled: true,
			now,
			config: { repairCap: 150, maxRepairToCohortRatio: 1 },
		})
		expect(receipt).toMatchObject({
			brake: { status: 'clear' },
			status: 'degraded',
			counts: { deferred: 1, writeFailed: 1 },
		})
	})

	it('accounts for each selected drip as created, noop, blocked, not-due, or failed', async () => {
		const repository = new InMemorySubscriberMarketingRepository()
		const fixtures = await Promise.all(
			['created', 'noop', 'blocked', 'failed'].map((kind, index) =>
				dryRunSubscriberMarketingFixture({
					repository,
					fixture: {
						...codingWorkflowFixture,
						providerEventId: `fixture-event-${kind}`,
						externalId: `fixture-contact-${kind}`,
						email: `${kind}-${index}@example.com`,
					},
					now: '2026-07-15T20:00:00.000Z',
				}),
			),
		)
		repository.sideEffectIntents.clear()
		const completed = fixtures.map((fixture, index) => {
			const emailSix = index === 2
			return repository.createSideEffectIntent({
				...courseIntent({
					contactId: fixture.contact.id,
					id: `completed-${index}`,
					status: 'completed',
					completedAt: '2026-07-15T20:00:00.000Z',
					emailResourceId: emailSix
						? 'ai-hero-skills-workflow.email-6'
						: 'ai-hero-skills-workflow.email-0',
					kitSequenceId: emailSix ? '2757205' : '2757199',
				}),
				metadata: {
					valuePathSlug: 'ai-hero-skills-workflow',
					emailResourceId: emailSix
						? 'ai-hero-skills-workflow.email-6'
						: 'ai-hero-skills-workflow.email-0',
					kitSequenceId: emailSix ? '2757205' : '2757199',
					kitSubscriberId: `kit-${index}`,
					completedAt: '2026-07-15T20:00:00.000Z',
				},
			})
		})
		repository.createSideEffectIntent({
			...courseIntent({
				contactId: fixtures[1]!.contact.id,
				id: 'existing-email-1',
				emailResourceId: 'ai-hero-skills-workflow.email-1',
				kitSequenceId: '2757200',
			}),
			idempotencyKey: `contact:${fixtures[1]!.contact.id}:value-path:ai-hero-skills-workflow:email:ai-hero-skills-workflow.email-1`,
		})
		const createContactEvent = repository.createContactEvent.bind(repository)
		repository.createContactEvent = (input) => {
			if (input.contactId === fixtures[3]!.contact.id) {
				throw new Error('simulated receipt accounting failure')
			}
			return createContactEvent(input)
		}
		const reconcilerRepository = Object.assign(repository, {
			findSkillsWorkflowLearnerFlowRecords: () =>
				fixtures.map((fixture, index) => ({
					contactId: fixture.contact.id,
					contact: fixture.contact,
					contactState: fixture.contactState,
					intents: [completed[index]!],
					entryEvents: [],
				})),
		})
		const receipt = await reconcileLearnerFlow({
			repository: reconcilerRepository,
			allowlist: emailSevenAllowlist(),
			email7LiveEnabled: false,
			now,
			config: { repairCap: 150, maxRepairToCohortRatio: 1 },
		})
		const accounted =
			receipt.counts.intentsCreated +
			receipt.counts.noop +
			receipt.counts.blocked +
			receipt.counts.notDue +
			receipt.counts.failed

		expect(receipt).toMatchObject({
			workSeen: 4,
			counts: {
				intentsCreated: 1,
				noop: 1,
				blocked: 1,
				notDue: 0,
				failed: 1,
				writeFailed: 1,
				deferred: 2,
			},
			blockedReasons: { 'email-7-copy-approval-required': 1 },
		})
		expect(accounted).toBe(receipt.workSeen)
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
		expect(functionSource).toContain('parseEmail7LiveEnabled')
		expect(functionSource).toContain(
			'process.env.AIH_VALUE_PATH_EMAIL_7_LIVE_ENABLED',
		)
		expect(functionSource).toContain('email7LiveEnabled')
		expect(configSource).toContain('learnerFlowReconciler')
		expect(configSource).not.toContain('valuePathDripProgression')
	})
})
