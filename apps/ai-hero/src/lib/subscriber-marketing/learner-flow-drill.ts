import { guid } from '@coursebuilder/utils/guid'
import { setup } from 'xstate'

import {
	isLearnerFlowFixtureEmail,
	learnerFlowFixtureEmail,
	LEARNER_FLOW_FIXTURE_EMAIL_RESOURCE,
	LEARNER_FLOW_FIXTURE_KIT_SEQUENCE_ID,
	LEARNER_FLOW_FIXTURE_PATH,
	type LearnerFlowFixtureRepository,
} from './learner-flow-fixture'
import type { LearnerFlowCohortRecord } from './learner-flow-cohort'
import type { ContactRecord, ContactState, SideEffectIntent } from './types'
import type { GateDRuntimeAllowlist } from './value-path-gate-d-allowlist'

export const LEARNER_FLOW_DRIFT_FIXTURE_ID_PREFIX = 'drill-drift-v1-'
export const LEARNER_FLOW_ZOMBIE_FIXTURE_ID_PREFIX = 'drill-zombie-v1-'
export const LEARNER_FLOW_DRILL_FIXTURE_COUNT = 3
export const LEARNER_FLOW_DRILL_IDENTICAL_RECEIPT_TARGET = 4
export const LEARNER_FLOW_DRILL_SUPPRESSION_HOURS = 6.5

export type LearnerFlowDrillScenario = 'drift' | 'zombie' | 'both'

export type LearnerFlowFixtureResidue = {
	contacts: number
	contactStates: number
	providerIdentities: number
	contactEvents: number
	stateTransitions: number
	nextActions: number
	sideEffectIntents: number
	contactLinks: number
	conversionUploads: number
	total: number
}

export type LearnerFlowDrillRepository = LearnerFlowFixtureRepository & {
	createDriftIntentWithoutCompletionFact(
		intent: SideEffectIntent,
	): Promise<SideEffectIntent>
	findLearnerFlowDrillContacts(): Promise<ContactRecord[]>
	deleteLearnerFlowFixtureContact(contactId: string): Promise<void>
	readLearnerFlowFixtureResidue(
		contactId: string,
	): Promise<LearnerFlowFixtureResidue>
}

export type LearnerFlowDrillFixture = {
	scenario: Exclude<LearnerFlowDrillScenario, 'both'>
	fixtureId: string
	email: string
	contactId?: string
	intentId?: string
	intentShape: {
		status: 'completed'
		completedAt: string | null
		metadataCompletedAt: boolean
		providerCompletedAt: string
		suppressedUntil?: string
	}
}

export type LearnerFlowDrillSuppression = {
	contactId: string
	intentId: string
	fixtureId: string
	suppressedUntil: string
}

export function learnerFlowDrillEligibility(
	allowlist: GateDRuntimeAllowlist,
) {
	const allowedActions = allowlist.allowedActions ?? []
	const reviewReasons = [
		...(allowlist.authorizationMode === 'rolling-public-enrollment'
			? []
			: ['authorization-mode-not-rolling-public-enrollment']),
		...(allowlist.mode === 'scoped-live'
			? []
			: ['gate-d-mode-not-scoped-live']),
		...(allowlist.pathSlugs.includes('ai-hero-skills-workflow')
			? []
			: ['skills-workflow-path-not-enabled']),
		...(allowlist.emailResourceIds.includes(
			'ai-hero-skills-workflow.email-1',
		)
			? []
			: ['email-1-not-verified']),
		...(allowlist.kitSequenceIds.includes('2757200')
			? []
			: ['email-1-kit-sequence-not-verified']),
		...(allowedActions.includes('advance-by-daily-drip')
			? []
			: ['daily-drip-action-not-authorized']),
		...(allowedActions.includes('send-path-emails')
			? []
			: ['send-path-email-action-not-authorized']),
	]
	return {
		passed: reviewReasons.length === 0,
		reviewReasons,
		authorizationMode: allowlist.authorizationMode,
		mode: allowlist.mode,
		pathEnabled: allowlist.pathSlugs.includes('ai-hero-skills-workflow'),
		email1Verified: allowlist.emailResourceIds.includes(
			'ai-hero-skills-workflow.email-1',
		),
		sequenceVerified: allowlist.kitSequenceIds.includes('2757200'),
		actionsAuthorized: {
			advanceByDailyDrip: allowedActions.includes('advance-by-daily-drip'),
			sendPathEmails: allowedActions.includes('send-path-emails'),
		},
	}
}

export function isLearnerFlowDrillFixtureId(value?: string | null) {
	return Boolean(
		value &&
			(value.startsWith(LEARNER_FLOW_DRIFT_FIXTURE_ID_PREFIX) ||
				value.startsWith(LEARNER_FLOW_ZOMBIE_FIXTURE_ID_PREFIX)),
	)
}

export function isLearnerFlowDrillEmail(value?: string | null) {
	if (!isLearnerFlowFixtureEmail(value)) return false
	const normalized = value!.trim().toLowerCase()
	return (
		normalized.startsWith(
			`joel+aih-synth-${LEARNER_FLOW_DRIFT_FIXTURE_ID_PREFIX}`,
		) ||
		normalized.startsWith(
			`joel+aih-synth-${LEARNER_FLOW_ZOMBIE_FIXTURE_ID_PREFIX}`,
		)
	)
}

/**
 * Returns a suppression only when the contact and intent both prove they are
 * in the drill zombie namespace. A real learner cannot match this predicate.
 */
export function learnerFlowDrillSuppression(
	record: LearnerFlowCohortRecord,
	now: string,
): LearnerFlowDrillSuppression | undefined {
	if (!isLearnerFlowDrillEmail(record.contact?.email)) return undefined
	for (const intent of record.intents) {
		const fixtureId = stringField(intent.metadata.learnerFlowFixtureId)
		const suppressedUntil = stringField(
			intent.metadata.learnerFlowDrillSuppressedUntil,
		)
		if (
			intent.metadata.learnerFlowFixture !== true ||
			intent.metadata.learnerFlowDrill !== true ||
			intent.metadata.learnerFlowDrillScenario !== 'zombie' ||
			intent.metadata.learnerFlowFixtureStatus !== 'active' ||
			!fixtureId?.startsWith(LEARNER_FLOW_ZOMBIE_FIXTURE_ID_PREFIX) ||
			!suppressedUntil ||
			Number.isNaN(Date.parse(suppressedUntil)) ||
			Date.parse(suppressedUntil) <= Date.parse(now)
		) {
			continue
		}
		return {
			contactId: record.contactId,
			intentId: intent.id,
			fixtureId,
			suppressedUntil: new Date(suppressedUntil).toISOString(),
		}
	}
	return undefined
}

export async function createLearnerFlowDrillFixtures(args: {
	repository: LearnerFlowDrillRepository
	runId: string
	scenario: Exclude<LearnerFlowDrillScenario, 'both'>
	allowWrite: boolean
	count?: number
	now?: string
	suppressionHours?: number
}): Promise<LearnerFlowDrillFixture[]> {
	const now = args.now ?? new Date().toISOString()
	const count = args.count ?? LEARNER_FLOW_DRILL_FIXTURE_COUNT
	if (!Number.isInteger(count) || count < 3 || count > 5) {
		throw new Error('Learner-flow drill fixture count must be between 3 and 5')
	}
	const prefix =
		args.scenario === 'drift'
			? LEARNER_FLOW_DRIFT_FIXTURE_ID_PREFIX
			: LEARNER_FLOW_ZOMBIE_FIXTURE_ID_PREFIX
	const providerCompletedAt = new Date(
		Date.parse(now) - 24 * 60 * 60 * 1000,
	).toISOString()
	const suppressionHours =
		args.suppressionHours ?? LEARNER_FLOW_DRILL_SUPPRESSION_HOURS
	if (
		args.scenario === 'zombie' &&
		(!Number.isFinite(suppressionHours) ||
			suppressionHours < LEARNER_FLOW_DRILL_IDENTICAL_RECEIPT_TARGET)
	) {
		throw new Error(
			'Zombie suppression must span at least four hours for the identical-payload gate',
		)
	}
	const suppressedUntil =
		args.scenario === 'zombie'
			? new Date(
					Date.parse(now) + suppressionHours * 60 * 60 * 1000,
				).toISOString()
			: undefined
	const fixtures: LearnerFlowDrillFixture[] = []

	for (let index = 0; index < count; index += 1) {
		const fixtureId = `${prefix}${args.runId}-${index + 1}`
		const email = learnerFlowFixtureEmail(fixtureId)
		const shape: LearnerFlowDrillFixture = {
			scenario: args.scenario,
			fixtureId,
			email,
			intentShape: {
				status: 'completed',
				completedAt:
					args.scenario === 'drift' ? null : providerCompletedAt,
				metadataCompletedAt: args.scenario !== 'drift',
				providerCompletedAt,
				...(suppressedUntil ? { suppressedUntil } : {}),
			},
		}
		if (!args.allowWrite) {
			fixtures.push(shape)
			continue
		}
		const existing = await args.repository.findContactByEmail(email)
		if (existing) {
			throw new Error(
				`Drill fixture ${fixtureId} already exists. Run learner-flow-drill --cleanup or use a new run id.`,
			)
		}

		const contact = await createFixtureContact({
			repository: args.repository,
			email,
			fixtureId,
			now,
		})
		const intent = drillIntent({
			contactId: contact.id,
			fixtureId,
			scenario: args.scenario,
			providerCompletedAt,
			suppressedUntil,
			now,
		})
		const createdIntent =
			args.scenario === 'drift'
				? await args.repository.createDriftIntentWithoutCompletionFact(intent)
				: await args.repository.createSideEffectIntent(intent)
		fixtures.push({
			...shape,
			contactId: contact.id,
			intentId: createdIntent.id,
		})
	}
	return fixtures
}

export async function cleanupLearnerFlowDrillFixtures(args: {
	repository: LearnerFlowDrillRepository
	allowWrite: boolean
}) {
	const contacts = await args.repository.findLearnerFlowDrillContacts()
	if (contacts.some((contact) => !isLearnerFlowDrillEmail(contact.email))) {
		throw new Error('Cleanup refused: contact is outside the drill namespace')
	}
	const before = await readResidue(args.repository, contacts.map((item) => item.id))
	if (!args.allowWrite) {
		return {
			mode: 'learner-flow-drill' as const,
			operation: 'cleanup' as const,
			allowWrite: false,
			contactIds: contacts.map((contact) => contact.id),
			deleted: 0,
			wouldDelete: before,
		}
	}
	for (const item of contacts) {
		await args.repository.deleteLearnerFlowFixtureContact(item.id)
	}
	const postDeleteReadbacks = await Promise.all(
		contacts.map(async (item) => ({
			contactId: item.id,
			residue: await args.repository.readLearnerFlowFixtureResidue(item.id),
		})),
	)
	if (postDeleteReadbacks.some((item) => item.residue.total !== 0)) {
		throw new Error('Learner-flow drill cleanup left fixture residue')
	}
	return {
		mode: 'learner-flow-drill' as const,
		operation: 'cleanup' as const,
		allowWrite: true,
		contactIds: contacts.map((contact) => contact.id),
		deleted: contacts.length,
		before,
		postDeleteReadbacks,
	}
}

type DrillLifecycleContext = {
	runId: string
	scenario: LearnerFlowDrillScenario
	failure?: string
}

type DrillLifecycleEvent =
	| { type: 'START' }
	| { type: 'DRIFT_INDUCED' }
	| { type: 'DRIFT_HEALED' }
	| { type: 'ZOMBIE_INDUCED' }
	| { type: 'ZERO_PLAN_DETECTED' }
	| { type: 'IDENTICAL_PAYLOAD_DETECTED' }
	| { type: 'ZOMBIE_HEALED' }
	| { type: 'CLEANED' }
	| { type: 'FAIL'; error: string }

export const learnerFlowDrillMachine = setup({
	types: {
		context: {} as DrillLifecycleContext,
		input: {} as DrillLifecycleContext,
		events: {} as DrillLifecycleEvent,
	},
	actions: {
		recordFailure: ({ context, event }) => {
			if (event.type === 'FAIL') context.failure = event.error
		},
	},
	guards: {
		runsDrift: ({ context }) => context.scenario !== 'zombie',
		runsZombie: ({ context }) => context.scenario !== 'drift',
	},
}).createMachine({
	id: 'learnerFlowDrill',
	context: ({ input }) => input,
	initial: 'idle',
	states: {
		idle: {
			on: {
				START: [
					{ guard: 'runsDrift', target: 'inducingDrift' },
					{ target: 'inducingZombie' },
				],
			},
		},
		inducingDrift: {
			on: {
				DRIFT_INDUCED: 'waitingForDriftHeal',
				FAIL: { target: 'cleaning', actions: 'recordFailure' },
			},
		},
		waitingForDriftHeal: {
			on: {
				DRIFT_HEALED: [
					{ guard: 'runsZombie', target: 'inducingZombie' },
					{ target: 'cleaning' },
				],
				FAIL: { target: 'cleaning', actions: 'recordFailure' },
			},
		},
		inducingZombie: {
			on: {
				ZOMBIE_INDUCED: 'waitingForZeroPlan',
				FAIL: { target: 'cleaning', actions: 'recordFailure' },
			},
		},
		waitingForZeroPlan: {
			on: {
				ZERO_PLAN_DETECTED: 'waitingForIdenticalPayloads',
				FAIL: { target: 'cleaning', actions: 'recordFailure' },
			},
		},
		waitingForIdenticalPayloads: {
			on: {
				IDENTICAL_PAYLOAD_DETECTED: 'waitingForZombieHeal',
				FAIL: { target: 'cleaning', actions: 'recordFailure' },
			},
		},
		waitingForZombieHeal: {
			on: {
				ZOMBIE_HEALED: 'cleaning',
				FAIL: { target: 'cleaning', actions: 'recordFailure' },
			},
		},
		cleaning: { on: { CLEANED: 'complete' } },
		complete: { type: 'final' },
	},
})

async function createFixtureContact(args: {
	repository: LearnerFlowDrillRepository
	email: string
	fixtureId: string
	now: string
}) {
	const contact = await args.repository.createContact({
		email: args.email,
		name: 'AIH Learner Flow Drill Fixture',
		lifecycle: 'nurture-ready',
		isProvisional: true,
		createdAt: args.now,
		updatedAt: args.now,
	})
	const state: ContactState = {
		id: guid(),
		contactId: contact.id,
		lifecycle: 'nurture-ready',
		primaryBucket: 'ai-coding-workflow-real-engineering',
		allBuckets: ['ai-coding-workflow-real-engineering'],
		whySignals: ['ai-coding-workflow-real-engineering'],
		whoSignals: [],
		confidence: 1,
		rationale: [`Synthetic learner-flow ${args.fixtureId} drill fixture.`],
		reviewSignals: [],
		humanReview: false,
		lastEventId: `learner-flow-drill:${args.fixtureId}`,
		schemaVersion: 1,
		updatedAt: args.now,
	}
	await args.repository.upsertContactState(state)
	return contact
}

function drillIntent(args: {
	contactId: string
	fixtureId: string
	scenario: Exclude<LearnerFlowDrillScenario, 'both'>
	providerCompletedAt: string
	suppressedUntil?: string
	now: string
}): SideEffectIntent {
	return {
		id: guid(),
		nextActionId: `learner-flow-drill:${args.fixtureId}:next-action`,
		contactId: args.contactId,
		provider: 'kit',
		type: 'send-value-path-email',
		status: 'completed',
		completedAt:
			args.scenario === 'drift' ? null : args.providerCompletedAt,
		idempotencyKey: `learner-flow-drill:${args.fixtureId}:email-0`,
		gates: [],
		reviewReasons: [],
		metadata: {
			mode: 'allowlisted-test',
			valuePathSlug: LEARNER_FLOW_FIXTURE_PATH,
			emailResourceId: LEARNER_FLOW_FIXTURE_EMAIL_RESOURCE,
			kitSequenceId: LEARNER_FLOW_FIXTURE_KIT_SEQUENCE_ID,
			learnerFlowFixture: true,
			learnerFlowFixtureId: args.fixtureId,
			learnerFlowFixtureStatus: 'active',
			learnerFlowDrill: true,
			learnerFlowDrillScenario: args.scenario,
			providerCompletedAt: args.providerCompletedAt,
			...(args.scenario === 'zombie'
				? {
						completedAt: args.providerCompletedAt,
						learnerFlowDrillSuppressedUntil: args.suppressedUntil,
					}
				: {}),
		},
		createdAt: args.now,
	}
}

async function readResidue(
	repository: LearnerFlowDrillRepository,
	contactIds: string[],
) {
	const rows = await Promise.all(
		contactIds.map((contactId) =>
			repository.readLearnerFlowFixtureResidue(contactId),
		),
	)
	return rows.reduce<LearnerFlowFixtureResidue>(
		(total, row) => ({
			contacts: total.contacts + row.contacts,
			contactStates: total.contactStates + row.contactStates,
			providerIdentities:
				total.providerIdentities + row.providerIdentities,
			contactEvents: total.contactEvents + row.contactEvents,
			stateTransitions: total.stateTransitions + row.stateTransitions,
			nextActions: total.nextActions + row.nextActions,
			sideEffectIntents: total.sideEffectIntents + row.sideEffectIntents,
			contactLinks: total.contactLinks + row.contactLinks,
			conversionUploads: total.conversionUploads + row.conversionUploads,
			total: total.total + row.total,
		}),
		emptyResidue(),
	)
}

function emptyResidue(): LearnerFlowFixtureResidue {
	return {
		contacts: 0,
		contactStates: 0,
		providerIdentities: 0,
		contactEvents: 0,
		stateTransitions: 0,
		nextActions: 0,
		sideEffectIntents: 0,
		contactLinks: 0,
		conversionUploads: 0,
		total: 0,
	}
}

function stringField(value: unknown) {
	return typeof value === 'string' && value.length > 0 ? value : undefined
}
