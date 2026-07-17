import { guid } from '@coursebuilder/utils/guid'

import { LEARNER_FLOW_CANARY_FIXTURE_ID_PREFIX } from './learner-flow-canary-exclusion'
import type {
	ContactRecord,
	ContactState,
	SideEffectIntent,
} from './types'

export {
	isLearnerFlowCanaryEmail,
	LEARNER_FLOW_CANARY_EMAIL_DOMAIN,
	LEARNER_FLOW_CANARY_EMAIL_PREFIX,
	LEARNER_FLOW_CANARY_FIXTURE_ID_PREFIX,
} from './learner-flow-canary-exclusion'

export const LEARNER_FLOW_FIXTURE_EMAIL_PREFIX = 'joel+aih-synth-'
export const LEARNER_FLOW_FIXTURE_EMAIL_DOMAIN = 'badass.dev'
export const LEARNER_FLOW_FIXTURE_PATH = 'ai-hero-skills-workflow'
export const LEARNER_FLOW_FIXTURE_EMAIL_RESOURCE = `${LEARNER_FLOW_FIXTURE_PATH}.email-0`
export const LEARNER_FLOW_FIXTURE_KIT_SEQUENCE_ID = '2757199'

export type LearnerFlowFixtureRepository = {
	findContactById(id: string): Promise<ContactRecord | undefined>
	findContactByEmail(email: string): Promise<ContactRecord | undefined>
	createContact(input: Omit<ContactRecord, 'id'>): Promise<ContactRecord>
	upsertContactState(state: ContactState): Promise<ContactState>
	findValuePathEmailSideEffectIntentsByContact(
		contactId: string,
	): Promise<SideEffectIntent[]>
	createSideEffectIntent(intent: SideEffectIntent): Promise<SideEffectIntent>
	updateSideEffectIntent(
		id: string,
		patch: Pick<
			SideEffectIntent,
			'status' | 'gates' | 'reviewReasons' | 'metadata'
		>,
	): Promise<SideEffectIntent>
}

export function learnerFlowFixtureId(now = new Date()) {
	return now
		.toISOString()
		.replace(/\.\d{3}Z$/, 'Z')
		.replace(/[-:]/g, '')
		.toLowerCase()
}

export function learnerFlowFixtureEmail(fixtureId: string) {
	if (!/^[a-z0-9-]{6,80}$/i.test(fixtureId)) {
		throw new Error('Fixture id must contain only letters, numbers, or hyphens')
	}
	return `${LEARNER_FLOW_FIXTURE_EMAIL_PREFIX}${fixtureId.toLowerCase()}@${LEARNER_FLOW_FIXTURE_EMAIL_DOMAIN}`
}

export function isLearnerFlowFixtureEmail(value?: string | null) {
	return Boolean(
		value &&
			/^joel\+aih-synth-[a-z0-9-]+@badass\.dev$/i.test(value.trim()),
	)
}

export function isLearnerFlowCanaryIntent(intent: SideEffectIntent) {
	return intent.metadata.learnerFlowCanary === true
}

export function isCleanedLearnerFlowFixtureIntent(intent: SideEffectIntent) {
	return (
		intent.status === 'skipped' &&
		intent.metadata.learnerFlowFixture === true &&
		intent.metadata.learnerFlowFixtureStatus === 'cleaned'
	)
}

export async function createLearnerFlowStuckFixture(args: {
	repository: LearnerFlowFixtureRepository
	fixtureId: string
	allowWrite: boolean
	now?: string
}) {
	const now = args.now ?? new Date().toISOString()
	const email = learnerFlowFixtureEmail(args.fixtureId)
	const existing = await args.repository.findContactByEmail(email)
	if (existing) {
		const intents =
			await args.repository.findValuePathEmailSideEffectIntentsByContact(
				existing.id,
			)
		const fixtureIntent = intents.find(
			(intent) => intent.metadata.learnerFlowFixture === true,
		)
		if (!fixtureIntent) {
			throw new Error('Synthetic fixture email belongs to a non-fixture contact')
		}
		return {
			mode: 'learner-flow-fixture-stuck' as const,
			operation: 'create' as const,
			allowWrite: args.allowWrite,
			created: false,
			fixtureId: args.fixtureId,
			contactId: existing.id,
			intentId: fixtureIntent.id,
			intentStatus: fixtureIntent.status,
			emailPattern: `${LEARNER_FLOW_FIXTURE_EMAIL_PREFIX}*@${LEARNER_FLOW_FIXTURE_EMAIL_DOMAIN}`,
		}
	}

	if (!args.allowWrite) {
		return {
			mode: 'learner-flow-fixture-stuck' as const,
			operation: 'create' as const,
			allowWrite: false,
			created: false,
			fixtureId: args.fixtureId,
			intentStatus: 'blocked' as const,
			emailPattern: `${LEARNER_FLOW_FIXTURE_EMAIL_PREFIX}*@${LEARNER_FLOW_FIXTURE_EMAIL_DOMAIN}`,
			note: 'Dry-run only. Re-run with --allow-write to create one synthetic blocked email-0 intent.',
		}
	}

	const contact = await args.repository.createContact({
		email,
		name: 'AIH Synthetic Learner Flow Fixture',
		lifecycle: 'nurture-ready',
		isProvisional: true,
		createdAt: now,
		updatedAt: now,
	})
	const stateId = guid()
	await args.repository.upsertContactState({
		id: stateId,
		contactId: contact.id,
		lifecycle: 'nurture-ready',
		primaryBucket: 'ai-coding-workflow-real-engineering',
		allBuckets: ['ai-coding-workflow-real-engineering'],
		whySignals: ['ai-coding-workflow-real-engineering'],
		whoSignals: [],
		confidence: 1,
		rationale: ['Synthetic learner-flow verification fixture.'],
		reviewSignals: [],
		humanReview: false,
		lastEventId: `learner-flow-fixture:${args.fixtureId}`,
		schemaVersion: 1,
		updatedAt: now,
	})
	const intent = await args.repository.createSideEffectIntent({
		id: guid(),
		nextActionId: `learner-flow-fixture:${args.fixtureId}:next-action`,
		contactId: contact.id,
		provider: 'kit',
		type: 'send-value-path-email',
		status: 'blocked',
		idempotencyKey: `learner-flow-fixture:${args.fixtureId}:email-0`,
		gates: [
			{
				slug: 'gate-d-value-path-email',
				passed: false,
				reason: 'Synthetic stuck learner fixture.',
			},
		],
		reviewReasons: ['learner-flow-synthetic-stuck-fixture'],
		metadata: {
			mode: 'allowlisted-test',
			valuePathSlug: LEARNER_FLOW_FIXTURE_PATH,
			emailResourceId: LEARNER_FLOW_FIXTURE_EMAIL_RESOURCE,
			kitSequenceId: LEARNER_FLOW_FIXTURE_KIT_SEQUENCE_ID,
			learnerFlowFixture: true,
			learnerFlowFixtureId: args.fixtureId,
			learnerFlowFixtureStatus: 'active',
			blockedAt: now,
		},
		createdAt: now,
	})

	return {
		mode: 'learner-flow-fixture-stuck' as const,
		operation: 'create' as const,
		allowWrite: true,
		created: true,
		fixtureId: args.fixtureId,
		contactId: contact.id,
		intentId: intent.id,
		intentStatus: intent.status,
		emailPattern: `${LEARNER_FLOW_FIXTURE_EMAIL_PREFIX}*@${LEARNER_FLOW_FIXTURE_EMAIL_DOMAIN}`,
	}
}

export async function createLearnerFlowCanaryFixture(args: {
	repository: LearnerFlowFixtureRepository
	allowWrite: boolean
	fixtureId: string
	stalled?: boolean
	now?: string
}) {
	if (!args.fixtureId.startsWith(LEARNER_FLOW_CANARY_FIXTURE_ID_PREFIX)) {
		throw new Error('Canary fixture id is outside the canary namespace')
	}
	const created = await createLearnerFlowStuckFixture({
		repository: args.repository,
		fixtureId: args.fixtureId,
		allowWrite: args.allowWrite,
		now: args.now,
	})
	if (!args.allowWrite || !created.intentId) {
		return {
			...created,
			mode: 'learner-flow-canary' as const,
			operation: 'seed' as const,
			stalled: Boolean(args.stalled),
		}
	}

	const intents =
		await args.repository.findValuePathEmailSideEffectIntentsByContact(
			created.contactId!,
		)
	const intent = intents.find((candidate) => candidate.id === created.intentId)
	if (!intent) throw new Error(`Missing canary intent ${created.intentId}`)
	if (intent.metadata.learnerFlowCanary !== true) {
		const now = args.now ?? new Date().toISOString()
		const updated = await args.repository.updateSideEffectIntent(intent.id, {
			status: args.stalled ? 'blocked' : 'pending',
			gates: [
				{
					slug: 'gate-d-value-path-email',
					passed: !args.stalled,
					reason: args.stalled
						? 'Synthetic canary stall fixture.'
						: 'Synthetic canary is eligible for the real executor.',
				},
			],
			reviewReasons: args.stalled
				? ['learner-flow-canary-synthetic-stall']
				: [],
			metadata: {
				...intent.metadata,
				learnerFlowCanary: true,
				learnerFlowCanaryCadenceHours: 1,
				learnerFlowCanarySeededAt: now,
				...(args.stalled ? { blockedAt: now } : { providerResult: null }),
			},
		})
		return {
			...created,
			mode: 'learner-flow-canary' as const,
			operation: 'seed' as const,
			intentStatus: updated.status,
			stalled: Boolean(args.stalled),
		}
	}

	return {
		...created,
		mode: 'learner-flow-canary' as const,
		operation: 'seed' as const,
		intentStatus: intent.status,
		stalled: intent.status === 'blocked',
	}
}

export async function cleanupLearnerFlowStuckFixture(args: {
	repository: LearnerFlowFixtureRepository
	contactId: string
	allowWrite: boolean
	now?: string
}) {
	const now = args.now ?? new Date().toISOString()
	const contact = await args.repository.findContactById(args.contactId)
	if (!contact) throw new Error(`Missing fixture contact ${args.contactId}`)
	if (!isLearnerFlowFixtureEmail(contact.email)) {
		throw new Error('Cleanup refused: contact is not a synthetic fixture address')
	}
	const fixtureIntents = (
		await args.repository.findValuePathEmailSideEffectIntentsByContact(
			contact.id,
		)
	).filter((intent) => intent.metadata.learnerFlowFixture === true)
	if (fixtureIntents.length === 0) {
		throw new Error('Cleanup refused: contact has no learner-flow fixture intents')
	}

	const active = fixtureIntents.filter(
		(intent) => !isCleanedLearnerFlowFixtureIntent(intent),
	)
	if (args.allowWrite) {
		for (const intent of active) {
			await args.repository.updateSideEffectIntent(intent.id, {
				status: 'skipped',
				gates: intent.gates,
				reviewReasons: [],
				metadata: {
					...intent.metadata,
					learnerFlowFixtureStatus: 'cleaned',
					learnerFlowFixturePreviousStatus: intent.status,
					learnerFlowFixtureCleanedAt: now,
				},
			})
		}
	}

	return {
		mode: 'learner-flow-fixture-stuck' as const,
		operation: 'cleanup' as const,
		allowWrite: args.allowWrite,
		contactId: contact.id,
		counts: {
			fixtureIntents: fixtureIntents.length,
			active: active.length,
			skipped: args.allowWrite ? active.length : 0,
			wouldSkip: args.allowWrite ? 0 : active.length,
			alreadyCleaned: fixtureIntents.length - active.length,
		},
	}
}
