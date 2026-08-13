import { isCleanedLearnerFlowFixtureIntent } from './learner-flow-fixture'
import {
	isTerminalSkillsWorkflowEmailResourceId,
	nextSkillsWorkflowEmailResourceId,
	SKILLS_WORKFLOW_PATH_SLUGS,
} from './skills-workflow-path'
import {
	isValuePathIntentCompleted,
	valuePathIntentCompletedAt,
} from './value-path-completion'
import type {
	ContactEventRecord,
	ContactRecord,
	ContactState,
	SideEffectIntent,
} from './types'
import { isLocalDayDripDue } from './value-path-drip-due'

export const LEARNER_FLOW_MOVEMENT_TOLERANCE_HOURS = 48

export const COURSE_VALUE_PATH_SLUGS = SKILLS_WORKFLOW_PATH_SLUGS

type CourseValuePathSlug = (typeof COURSE_VALUE_PATH_SLUGS)[number]

export type LearnerFlowState = 'moving' | 'terminal' | 'stuck'
export const LEARNER_FLOW_STUCK_CAUSES = [
	'blocked-intent',
	'provider-retries-exhausted',
	'provider-permanent-failure',
	'drip-starved',
	'bounced',
	'complained',
	'unsubscribed',
	'human-review-parked',
	'classifier-gap',
] as const

export type LearnerFlowStuckCause =
	(typeof LEARNER_FLOW_STUCK_CAUSES)[number]

export type LearnerFlowClassification = {
	state: LearnerFlowState
	stage: string
	stuckAgeHours?: number
	lastActivityAt?: string
	cause?: LearnerFlowStuckCause
	intentId?: string
	unstickCommand?: string
}

export type LearnerFlowIntent = Pick<
	SideEffectIntent,
	| 'id'
	| 'contactId'
	| 'provider'
	| 'type'
	| 'status'
	| 'completedAt'
	| 'reviewReasons'
	| 'metadata'
	| 'createdAt'
>

export type LearnerFlowContactInput = {
	contactId: string
	contact?: Pick<ContactRecord, 'id' | 'email'>
	contactState?: Pick<ContactState, 'humanReview' | 'lifecycle'>
	intents: LearnerFlowIntent[]
	entryEvents?: Pick<
		ContactEventRecord,
		'eventType' | 'occurredAt' | 'providerReference'
	>[]
	dripScheduleEvidence?: { timezone?: string }
	now: string
}

/**
 * Classifies a course-path learner without mutating provider or database state.
 * Terminal wins because a completed final email is the settled course outcome;
 * otherwise safety stops and failed/blocking intents are visible as stuck.
 */
export function classifyLearnerFlowContact(
	input: LearnerFlowContactInput,
): LearnerFlowClassification {
	const intents = input.intents.filter(isCourseValuePathIntent)
	if (intents.length === 0) {
		const entry = latestCourseEntryEvent(input.entryEvents ?? [])
		return stuck({
			stage: entry ? firstEmailResourceId(entry.providerReference) : 'unknown',
			cause: 'classifier-gap',
			contactId: input.contactId,
			lastActivityAt: entry?.occurredAt,
			now: input.now,
		})
	}

	const path = latestPath(intents)
	const pathIntents = intents.filter(
		(intent) => valuePathSlug(intent) === path,
	)
	const current = mostAdvancedIntent(pathIntents)
	const stage = emailResourceId(current) ?? 'unknown'
	const lastActivityAt = latestActivityAt(pathIntents)

	if (pathIntents.some(isCompletedTerminalIntent)) {
		return { state: 'terminal', stage }
	}

	for (const cause of ['bounced', 'complained', 'unsubscribed'] as const) {
		if (pathIntents.some((intent) => hasSignal(intent, cause))) {
			return stuck({
				stage,
				cause,
				contactId: input.contactId,
				lastActivityAt,
				now: input.now,
			})
		}
	}

	const blocked = pathIntents.find(
		(intent) =>
			!isValuePathIntentCompleted(intent) && intent.status === 'blocked',
	)
	if (blocked) {
		return stuck({
			stage: emailResourceId(blocked) ?? stage,
			cause: 'blocked-intent',
			contactId: input.contactId,
			intentId: blocked.id,
			lastActivityAt,
			now: input.now,
		})
	}

	const failed = pathIntents.find(
		(intent) =>
			!isValuePathIntentCompleted(intent) && intent.status === 'failed',
	)
	if (failed) {
		if (failed.metadata.retryable === true) {
			return { state: 'moving', stage: emailResourceId(failed) ?? stage }
		}
		if (hasExhaustedTransientProviderRetries(failed)) {
			return stuck({
				stage: emailResourceId(failed) ?? stage,
				cause: 'provider-retries-exhausted',
				contactId: input.contactId,
				intentId: failed.id,
				lastActivityAt,
				now: input.now,
			})
		}
		return stuck({
			stage: emailResourceId(failed) ?? stage,
			cause: 'provider-permanent-failure',
			contactId: input.contactId,
			intentId: failed.id,
			lastActivityAt,
			now: input.now,
		})
	}

	const completed = mostAdvancedCompletedIntent(pathIntents)
	if (completed) {
		const nextStep = nextSkillsWorkflowEmailResourceId(emailResourceId(completed))
		if (!nextStep) {
			return stuck({
				stage: emailResourceId(completed) ?? stage,
				cause: 'classifier-gap',
				contactId: input.contactId,
				lastActivityAt,
				now: input.now,
			})
		}
		const nextIntent = pathIntents.find(
			(intent) => emailResourceId(intent) === nextStep,
		)
		const dripDue = isLocalDayDripDue({
			completedAt: valuePathIntentCompletedAt(completed),
			now: input.now,
			scheduleEvidence: input.dripScheduleEvidence,
			cadenceHours: numberField(
				completed.metadata.learnerFlowCanaryCadenceHours,
			),
		})
		if (!nextIntent && dripDue.due) {
			return stuck({
				stage: emailResourceId(completed) ?? stage,
				cause: 'drip-starved',
				contactId: input.contactId,
				intentId: completed.id,
				lastActivityAt,
				now: input.now,
			})
		}
	}

	if (hasRecentCourseProgress(pathIntents, input.now)) {
		return { state: 'moving', stage }
	}

	if (hasBlockingHumanReview(input)) {
		return stuck({
			stage,
			cause: 'human-review-parked',
			contactId: input.contactId,
			lastActivityAt,
			now: input.now,
		})
	}

	return stuck({
		stage,
		cause: 'classifier-gap',
		contactId: input.contactId,
		lastActivityAt,
		now: input.now,
	})
}

export function isCourseValuePathIntent(intent: LearnerFlowIntent) {
	if (isCleanedLearnerFlowFixtureIntent(intent)) return false
	if (intent.provider !== 'kit' || intent.type !== 'send-value-path-email') {
		return false
	}
	const path = valuePathSlug(intent)
	return Boolean(path && COURSE_VALUE_PATH_SLUGS.includes(path))
}

function stuck(args: {
	stage: string
	cause: LearnerFlowStuckCause
	contactId: string
	intentId?: string
	lastActivityAt?: string
	now: string
}): LearnerFlowClassification {
	return {
		state: 'stuck',
		stage: args.stage,
		stuckAgeHours: args.lastActivityAt
			? hoursSince(args.lastActivityAt, args.now)
			: undefined,
		lastActivityAt: args.lastActivityAt,
		cause: args.cause,
		intentId: args.intentId,
		unstickCommand: unstickCommand(args.cause, args.contactId),
	}
}

function unstickCommand(cause: LearnerFlowStuckCause, contactId: string) {
	const operator = 'pnpm --filter ai-hero subscriber-marketing:operator'
	if (cause === 'blocked-intent') {
		return `${operator} value-path-intent-replan --contact-ids ${contactId} --allow-write`
	}
	if (
		cause === 'bounced' ||
		cause === 'complained' ||
		cause === 'unsubscribed' ||
		cause === 'human-review-parked' ||
		cause === 'provider-retries-exhausted' ||
		cause === 'provider-permanent-failure'
	) {
		return `tier-2: ask Joel (${cause}; contact ${contactId})`
	}
	if (cause === 'drip-starved') {
		return `${operator} value-path-drip-progress --allow-write`
	}
	return `tier-2: ask Joel (classifier-gap; contact ${contactId})`
}

function isCompletedTerminalIntent(intent: LearnerFlowIntent) {
	return (
		isValuePathIntentCompleted(intent) &&
		isTerminalSkillsWorkflowEmailResourceId(emailResourceId(intent))
	)
}

function mostAdvancedCompletedIntent(intents: LearnerFlowIntent[]) {
	return mostAdvancedIntent(intents.filter(isValuePathIntentCompleted))
}

function mostAdvancedIntent(intents: LearnerFlowIntent[]) {
	return [...intents].sort((left, right) => {
		const stageDifference = emailStepNumber(right) - emailStepNumber(left)
		if (stageDifference !== 0) return stageDifference
		return activityAt(right).localeCompare(activityAt(left))
	})[0]
}

function latestPath(intents: LearnerFlowIntent[]): CourseValuePathSlug | undefined {
	const latest = [...intents].sort((left, right) =>
		activityAt(right).localeCompare(activityAt(left)),
	)[0]
	return latest ? valuePathSlug(latest) : undefined
}

function valuePathSlug(intent: LearnerFlowIntent): CourseValuePathSlug | undefined {
	const value = intent.metadata.valuePathSlug
	if (COURSE_VALUE_PATH_SLUGS.includes(value as CourseValuePathSlug)) {
		return value as CourseValuePathSlug
	}
	const resourceId = emailResourceId(intent)
	return COURSE_VALUE_PATH_SLUGS.find((path) =>
		resourceId?.startsWith(`${path}.`),
	)
}

function emailResourceId(intent?: LearnerFlowIntent) {
	const value = intent?.metadata.emailResourceId
	return typeof value === 'string' && value.length > 0 ? value : undefined
}

function latestCourseEntryEvent(
	events: LearnerFlowContactInput['entryEvents'],
) {
	return [...(events ?? [])]
		.filter(
			(event) =>
				event.eventType === 'value-path.entered' &&
				event.providerReference.startsWith('value-path:'),
		)
		.sort((left, right) => right.occurredAt.localeCompare(left.occurredAt))[0]
}

function firstEmailResourceId(providerReference: string) {
	const path = providerReference.replace(/^value-path:/, '')
	return path === 'ai-hero-skills-team-workflow'
		? `${path}.team-email-0`
		: `${path}.email-0`
}

function emailStepNumber(intent: LearnerFlowIntent) {
	const match = emailResourceId(intent)?.match(/(?:team-)?email-(\d+)$/)
	return match ? Number(match[1]) : -1
}

function latestActivityAt(intents: LearnerFlowIntent[]) {
	const timestamps = intents.map(activityAt).filter(Boolean).sort()
	return timestamps[timestamps.length - 1]
}

function activityAt(intent: LearnerFlowIntent) {
	return valuePathIntentCompletedAt(intent) ??
		(validDate(intent.createdAt) ? intent.createdAt : '')
}

function hasSignal(intent: LearnerFlowIntent, signal: string) {
	if (intent.reviewReasons.includes(signal)) return true
	if (intent.metadata[signal] === true) return true
	const providerResult = intent.metadata.providerResult
	return Boolean(
		providerResult &&
			typeof providerResult === 'object' &&
			(providerResult as Record<string, unknown>)[signal] === true,
	)
}

const TRANSIENT_PROVIDER_RETRY_REASONS = new Set([
	'kit-retry-later',
	'kit-timeout',
	'kit-invalid-json-response',
	'kit-rate-limited',
	'kit-5xx',
])

function hasExhaustedTransientProviderRetries(intent: LearnerFlowIntent) {
	const retryAttemptCount = numberField(intent.metadata.retryAttemptCount)
	const maxRetryAttempts = numberField(intent.metadata.maxRetryAttempts)
	const retryReason = intent.metadata.retryReason
	return (
		retryAttemptCount !== undefined &&
		maxRetryAttempts !== undefined &&
		retryAttemptCount >= maxRetryAttempts &&
		typeof retryReason === 'string' &&
		TRANSIENT_PROVIDER_RETRY_REASONS.has(retryReason)
	)
}

function hasRecentCourseProgress(intents: LearnerFlowIntent[], now: string) {
	return intents.some(
		(intent) =>
			(intent.status === 'pending' || isValuePathIntentCompleted(intent)) &&
			!exceedsMovementTolerance(intent, now),
	)
}

function hasBlockingHumanReview(input: LearnerFlowContactInput) {
	return Boolean(
		input.contactState?.humanReview ||
			input.contactState?.lifecycle === 'human-review' ||
			input.intents.some(
				(intent) =>
					intent.type === 'human-review' &&
					(intent.status === 'blocked' || intent.status === 'pending'),
			),
	)
}

function exceedsMovementTolerance(intent: LearnerFlowIntent, now: string) {
	const lastActivityAt = activityAt(intent)
	return (
		!lastActivityAt ||
		hoursSince(lastActivityAt, now) > LEARNER_FLOW_MOVEMENT_TOLERANCE_HOURS
	)
}

function hoursSince(then: string, now: string) {
	const milliseconds = new Date(now).getTime() - new Date(then).getTime()
	return Math.max(0, Math.round((milliseconds / (60 * 60 * 1000)) * 10) / 10)
}

function numberField(value: unknown) {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function validDate(value: string) {
	return !Number.isNaN(new Date(value).getTime())
}
