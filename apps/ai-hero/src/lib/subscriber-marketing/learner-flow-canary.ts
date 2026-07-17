import { createActor, setup } from 'xstate'

import {
	createLearnerFlowCanaryFixture,
	isLearnerFlowCanaryEmail,
	learnerFlowFixtureId,
	LEARNER_FLOW_CANARY_FIXTURE_ID_PREFIX,
	type LearnerFlowFixtureRepository,
} from './learner-flow-fixture'
import type { ContactRecord, SideEffectIntent } from './types'
import {
	isValuePathIntentCompleted,
	valuePathIntentCompletedAt,
} from './value-path-completion'
import type { ValuePathDripProgressionResult } from './value-path-drip-progression'

export const LEARNER_FLOW_CANARY_CADENCE_HOURS = 1
export const LEARNER_FLOW_CANARY_STALL_AFTER_HOURS = 1
export const LEARNER_FLOW_CANARY_VIRTUAL_DUE_AGE_HOURS = 24

export type LearnerFlowCanaryResidue = {
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

export type LearnerFlowCanaryRepository = LearnerFlowFixtureRepository & {
	deleteLearnerFlowFixtureContact(contactId: string): Promise<void>
	findLearnerFlowCanaryContacts(): Promise<ContactRecord[]>
	readLearnerFlowFixtureResidue(contactId: string): Promise<LearnerFlowCanaryResidue>
}

export type LearnerFlowCanaryAdvance = (args: {
	intent: SideEffectIntent
	now: string
}) => Promise<ValuePathDripProgressionResult>

type CanaryLifecycleState = 'absent' | 'awaiting-send' | 'ready-to-advance' | 'terminal' | 'stalled'

type CanaryObservation = {
	contactCount: number
	contactId?: string
	currentIntent?: SideEffectIntent
	activeIntentCount: number
	ageHours?: number
	stage?: string
}

type CanaryMachineInput = {
	observation: CanaryObservation
}

const learnerFlowCanaryMachine = setup({
	types: {
		context: {} as CanaryMachineInput,
		input: {} as CanaryMachineInput,
	},
	guards: {
		absent: ({ context }) => !context.observation.contactId || !context.observation.currentIntent,
		multipleContacts: ({ context }) => context.observation.contactCount !== 1,
		multipleActive: ({ context }) => context.observation.activeIntentCount !== 1,
		terminal: ({ context }) =>
			isValuePathIntentCompleted(context.observation.currentIntent) &&
			isTerminalCanaryIntent(context.observation.currentIntent!),
		failedOrBlocked: ({ context }) =>
			!isValuePathIntentCompleted(context.observation.currentIntent) &&
			(context.observation.currentIntent?.status === 'failed' ||
				context.observation.currentIntent?.status === 'blocked'),
		overdue: ({ context }) =>
			(context.observation.ageHours ?? 0) >= LEARNER_FLOW_CANARY_STALL_AFTER_HOURS,
		pending: ({ context }) =>
			!isValuePathIntentCompleted(context.observation.currentIntent) &&
			context.observation.currentIntent?.status === 'pending',
		completed: ({ context }) =>
			isValuePathIntentCompleted(context.observation.currentIntent),
	},
}).createMachine({
	context: ({ input }) => input,
	id: 'learnerFlowCanary',
	initial: 'checking',
	states: {
		checking: {
			always: [
				{ guard: 'absent', target: 'absent' },
				{ guard: 'multipleContacts', target: 'stalled' },
				{ guard: 'multipleActive', target: 'stalled' },
				{ guard: 'terminal', target: 'terminal' },
				{ guard: 'failedOrBlocked', target: 'stalled' },
				{ guard: 'overdue', target: 'stalled' },
				{ guard: 'pending', target: 'awaitingSend' },
				{ guard: 'completed', target: 'readyToAdvance' },
				{ target: 'stalled' },
			],
		},
		absent: { type: 'final' },
		awaitingSend: { type: 'final' },
		readyToAdvance: { type: 'final' },
		terminal: { type: 'final' },
		stalled: { type: 'final' },
	},
})

export async function seedLearnerFlowCanary(args: {
	repository: LearnerFlowCanaryRepository
	allowWrite: boolean
	stalled?: boolean
	now?: string
}) {
	const now = args.now ?? new Date().toISOString()
	const existing = await args.repository.findLearnerFlowCanaryContacts()
	if (existing.length > 0) {
		return {
			mode: 'learner-flow-canary' as const,
			operation: 'seed' as const,
			allowWrite: args.allowWrite,
			created: false,
			contactCount: existing.length,
			contactId: existing[0]?.id,
			note: 'Canary namespace already has a contact; cleanup before reseeding.',
		}
	}
	return createLearnerFlowCanaryFixture({
		repository: args.repository,
		allowWrite: args.allowWrite,
		fixtureId: `${LEARNER_FLOW_CANARY_FIXTURE_ID_PREFIX}${learnerFlowFixtureId(new Date(now))}`,
		stalled: args.stalled,
		now,
	})
}

export async function inspectLearnerFlowCanary(args: {
	repository: LearnerFlowCanaryRepository
	now?: string
}) {
	const now = args.now ?? new Date().toISOString()
	const observation = await observeCanary(args.repository, now)
	const lifecycle = resolveLifecycle(observation)
	return canaryStatus({ lifecycle, observation, now })
}

export async function tickLearnerFlowCanary(args: {
	repository: LearnerFlowCanaryRepository
	advance: LearnerFlowCanaryAdvance
	allowWrite: boolean
	now?: string
}) {
	const now = args.now ?? new Date().toISOString()
	const observation = await observeCanary(args.repository, now)
	const lifecycle = resolveLifecycle(observation)
	const before = canaryStatus({ lifecycle, observation, now })
	const alarm = lifecycle === 'stalled' ? canaryAlarm(before) : null

	if (!args.allowWrite) {
		return {
			...before,
			allowWrite: false,
			alarm,
			operation: 'tick' as const,
			plannedAction: actionForLifecycle(lifecycle, observation.currentIntent),
		}
	}

	if (lifecycle === 'absent') {
		if (observation.contactId) {
			await args.repository.deleteLearnerFlowFixtureContact(observation.contactId)
		}
		const seeded = await seedLearnerFlowCanary({
			repository: args.repository,
			allowWrite: true,
			now,
		})
		return {
			...before,
			allowWrite: true,
			alarm,
			operation: 'tick' as const,
			action: observation.contactId ? 'reseeded-corrupt' : 'seeded',
			seeded,
		}
	}

	if (lifecycle === 'terminal') {
		await args.repository.deleteLearnerFlowFixtureContact(observation.contactId!)
		const postDeleteReadback = await args.repository.readLearnerFlowFixtureResidue(
			observation.contactId!,
		)
		assertZeroResidue(postDeleteReadback)
		const seeded = await seedLearnerFlowCanary({
			repository: args.repository,
			allowWrite: true,
			now,
		})
		return {
			...before,
			allowWrite: true,
			alarm: null,
			operation: 'tick' as const,
			action: 'self-reset',
			postDeleteReadback,
			seeded,
		}
	}

	if (
		(lifecycle === 'ready-to-advance' || lifecycle === 'stalled') &&
		isValuePathIntentCompleted(observation.currentIntent)
	) {
		const currentIntent = observation.currentIntent!
		const virtualCompletedAt = new Date(
			Date.parse(now) - LEARNER_FLOW_CANARY_VIRTUAL_DUE_AGE_HOURS * 60 * 60 * 1000,
		).toISOString()
		const progression = await args.advance({
			intent: {
				...currentIntent,
				completedAt: virtualCompletedAt,
				metadata: {
					...currentIntent.metadata,
					completedAt: virtualCompletedAt,
					learnerFlowCanaryVirtualClock: true,
				},
			},
			now,
		})
		return {
			...before,
			allowWrite: true,
			alarm,
			operation: 'tick' as const,
			action: 'advanced',
			progression,
			virtualCompletedAt,
		}
	}

	return {
		...before,
		allowWrite: true,
		alarm,
		operation: 'tick' as const,
		action: lifecycle === 'stalled' ? 'alarm-only' : 'awaiting-executor',
	}
}

export async function cleanupLearnerFlowCanary(args: {
	repository: LearnerFlowCanaryRepository
	allowWrite: boolean
}) {
	const contacts = await args.repository.findLearnerFlowCanaryContacts()
	if (contacts.some((contact) => !isLearnerFlowCanaryEmail(contact.email))) {
		throw new Error('Cleanup refused: contact is outside the canary namespace')
	}
	if (contacts.length === 0) {
		return {
			mode: 'learner-flow-canary' as const,
			operation: 'cleanup' as const,
			allowWrite: args.allowWrite,
			contactIds: [] as string[],
			deleted: 0,
			postDeleteReadback: emptyResidue(),
		}
	}
	const before = sumResidue(
		await Promise.all(
			contacts.map((contact) => args.repository.readLearnerFlowFixtureResidue(contact.id)),
		),
	)
	if (!args.allowWrite) {
		return {
			mode: 'learner-flow-canary' as const,
			operation: 'cleanup' as const,
			allowWrite: false,
			contactIds: contacts.map((contact) => contact.id),
			deleted: 0,
			wouldDelete: before,
		}
	}
	for (const contact of contacts) {
		await args.repository.deleteLearnerFlowFixtureContact(contact.id)
	}
	const postDeleteReadback = sumResidue(
		await Promise.all(
			contacts.map((contact) => args.repository.readLearnerFlowFixtureResidue(contact.id)),
		),
	)
	assertZeroResidue(postDeleteReadback)
	return {
		mode: 'learner-flow-canary' as const,
		operation: 'cleanup' as const,
		allowWrite: true,
		contactIds: contacts.map((contact) => contact.id),
		deleted: contacts.length,
		before,
		postDeleteReadback,
	}
}

function resolveLifecycle(observation: CanaryObservation) {
	const actor = createActor(learnerFlowCanaryMachine, {
		input: { observation },
	})
	actor.start()
	const state = actor.getSnapshot().value
	actor.stop()
	return String(state).replace(
		/[A-Z]/g,
		(letter) => `-${letter.toLowerCase()}`,
	) as CanaryLifecycleState
}

async function observeCanary(
	repository: LearnerFlowCanaryRepository,
	now: string,
): Promise<CanaryObservation> {
	const contacts = await repository.findLearnerFlowCanaryContacts()
	const contact = contacts[0]
	if (!contact) return { contactCount: 0, activeIntentCount: 0 }
	const intents = await repository.findValuePathEmailSideEffectIntentsByContact(contact.id)
	const active = intents.filter((intent) => intent.status !== 'skipped')
	const currentIntent = [...active].sort(compareCanaryIntents)[0]
	return {
		contactCount: contacts.length,
		contactId: contact.id,
		currentIntent,
		activeIntentCount:
			active.filter((intent) => !isValuePathIntentCompleted(intent)).length ||
			(currentIntent ? 1 : 0),
		ageHours: currentIntent ? hoursBetween(activityAt(currentIntent), now) : undefined,
		stage: emailResourceId(currentIntent),
	}
}

function compareCanaryIntents(left: SideEffectIntent, right: SideEffectIntent) {
	const step = emailStep(right) - emailStep(left)
	return step || activityAt(right).localeCompare(activityAt(left))
}

function emailStep(intent: SideEffectIntent) {
	const match = emailResourceId(intent)?.match(/(?:team-)?email-(\d+)$/)
	return match ? Number(match[1]) : -1
}

function emailResourceId(intent?: SideEffectIntent) {
	const value = intent?.metadata.emailResourceId
	return typeof value === 'string' ? value : undefined
}

function isTerminalCanaryIntent(intent: SideEffectIntent) {
	return emailResourceId(intent)?.endsWith('.email-6') === true
}

function activityAt(intent: SideEffectIntent) {
	const completedAt = valuePathIntentCompletedAt(intent)
	if (completedAt) return completedAt
	for (const key of ['failedAt', 'blockedAt'] as const) {
		const value = intent.metadata[key]
		if (typeof value === 'string' && validDate(value)) return value
	}
	return intent.createdAt
}

function hoursBetween(then: string, now: string) {
	return Math.max(0, Date.parse(now) - Date.parse(then)) / (60 * 60 * 1000)
}

function validDate(value: string) {
	return !Number.isNaN(Date.parse(value))
}

function canaryStatus(args: {
	lifecycle: CanaryLifecycleState
	observation: CanaryObservation
	now: string
}) {
	return {
		mode: 'learner-flow-canary' as const,
		checkedAt: args.now,
		lifecycle: args.lifecycle,
		contactId: args.observation.contactId,
		intentId: args.observation.currentIntent?.id,
		intentStatus: args.observation.currentIntent?.status,
		stage: args.observation.stage,
		ageHours:
			args.observation.ageHours === undefined
				? undefined
				: Math.round(args.observation.ageHours * 100) / 100,
		contactCount: args.observation.contactCount,
		activeIntentCount: args.observation.activeIntentCount,
	}
}

function canaryAlarm(status: ReturnType<typeof canaryStatus>) {
	return {
		event: 'subscriber_funnel.canary_stalled' as const,
		severity: 'critical' as const,
		funnel: 'skills-newsletter' as const,
		checkedAt: status.checkedAt,
		contactId: status.contactId,
		intentId: status.intentId,
		intentStatus: status.intentStatus,
		stage: status.stage,
		ageHours: status.ageHours,
		reason:
			status.contactCount !== 1
				? 'canary-contact-count-invalid'
				: status.activeIntentCount !== 1
					? 'canary-active-intent-count-invalid'
					: `canary-${status.intentStatus ?? 'missing'}-overdue`,
	}
}

function actionForLifecycle(lifecycle: CanaryLifecycleState, intent?: SideEffectIntent) {
	if (lifecycle === 'absent') return 'seed'
	if (lifecycle === 'terminal') return 'self-reset'
	if (
		(lifecycle === 'ready-to-advance' || lifecycle === 'stalled') &&
		isValuePathIntentCompleted(intent)
	) {
		return 'advance'
	}
	return lifecycle === 'stalled' ? 'alarm-only' : 'await-executor'
}

function emptyResidue(): LearnerFlowCanaryResidue {
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

function sumResidue(items: LearnerFlowCanaryResidue[]): LearnerFlowCanaryResidue {
	return items.reduce(
		(total, item) => ({
			contacts: total.contacts + item.contacts,
			contactStates: total.contactStates + item.contactStates,
			providerIdentities: total.providerIdentities + item.providerIdentities,
			contactEvents: total.contactEvents + item.contactEvents,
			stateTransitions: total.stateTransitions + item.stateTransitions,
			nextActions: total.nextActions + item.nextActions,
			sideEffectIntents: total.sideEffectIntents + item.sideEffectIntents,
			contactLinks: total.contactLinks + item.contactLinks,
			conversionUploads: total.conversionUploads + item.conversionUploads,
			total: total.total + item.total,
		}),
		emptyResidue(),
	)
}

function assertZeroResidue(residue: LearnerFlowCanaryResidue) {
	if (residue.total !== 0) {
		throw new Error(`Canary cleanup left ${residue.total} rows behind`)
	}
}
