import { isDueRetryableValuePathEmailIntent } from './value-path-email-executor'
import { isCleanedLearnerFlowFixtureIntent } from './learner-flow-fixture'
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

export const COURSE_VALUE_PATH_SLUGS = [
	'ai-hero-skills-workflow',
	'ai-hero-skills-team-workflow',
] as const

type CourseValuePathSlug = (typeof COURSE_VALUE_PATH_SLUGS)[number]

export type LearnerFlowState = 'moving' | 'terminal' | 'stuck'
export const LEARNER_FLOW_STUCK_CAUSES = [
	'blocked-intent',
	'failed-send',
	'retryable-failed-overdue',
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

export type LearnerFlowContactInput = {
	contactId: string
	contact?: Pick<ContactRecord, 'id' | 'email'>
	contactState?: Pick<ContactState, 'humanReview' | 'lifecycle'>
	intents: SideEffectIntent[]
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
		if (isDueRetryableValuePathEmailIntent(failed, input.now)) {
			return stuck({
				stage: emailResourceId(failed) ?? stage,
				cause: 'retryable-failed-overdue',
				contactId: input.contactId,
				intentId: failed.id,
				lastActivityAt,
				now: input.now,
			})
		}
		if (
			failed.metadata.retryable === true &&
			isScheduledRetry(failed, input.now)
		) {
			return { state: 'moving', stage: emailResourceId(failed) ?? stage }
		}
		if (failed.metadata.retryable !== true) {
			return stuck({
				stage: emailResourceId(failed) ?? stage,
				cause: 'failed-send',
				contactId: input.contactId,
				lastActivityAt,
				now: input.now,
			})
		}
	}

	const completed = mostAdvancedCompletedIntent(pathIntents)
	if (completed) {
		const nextStep = nextEmailResourceId(emailResourceId(completed))
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

export function isCourseValuePathIntent(intent: SideEffectIntent) {
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
	if (cause === 'retryable-failed-overdue') {
		return `${operator} value-path-email-executor --allow-write --mode scoped-live --allow-scoped-live --use-gate-d-allowlist`
	}
	if (
		cause === 'bounced' ||
		cause === 'complained' ||
		cause === 'unsubscribed' ||
		cause === 'human-review-parked' ||
		cause === 'failed-send'
	) {
		return `tier-2: ask Joel (${cause}; contact ${contactId})`
	}
	if (cause === 'drip-starved') {
		return `${operator} value-path-drip-progress --allow-write`
	}
	return `tier-2: ask Joel (classifier-gap; contact ${contactId})`
}

function isCompletedTerminalIntent(intent: SideEffectIntent) {
	return (
		isValuePathIntentCompleted(intent) &&
		isTerminalEmailResourceId(emailResourceId(intent))
	)
}

function mostAdvancedCompletedIntent(intents: SideEffectIntent[]) {
	return mostAdvancedIntent(intents.filter(isValuePathIntentCompleted))
}

function mostAdvancedIntent(intents: SideEffectIntent[]) {
	return [...intents].sort((left, right) => {
		const stageDifference = emailStepNumber(right) - emailStepNumber(left)
		if (stageDifference !== 0) return stageDifference
		return activityAt(right).localeCompare(activityAt(left))
	})[0]
}

function latestPath(intents: SideEffectIntent[]): CourseValuePathSlug | undefined {
	const latest = [...intents].sort((left, right) =>
		activityAt(right).localeCompare(activityAt(left)),
	)[0]
	return latest ? valuePathSlug(latest) : undefined
}

function valuePathSlug(intent: SideEffectIntent): CourseValuePathSlug | undefined {
	const value = intent.metadata.valuePathSlug
	if (COURSE_VALUE_PATH_SLUGS.includes(value as CourseValuePathSlug)) {
		return value as CourseValuePathSlug
	}
	const resourceId = emailResourceId(intent)
	return COURSE_VALUE_PATH_SLUGS.find((path) =>
		resourceId?.startsWith(`${path}.`),
	)
}

function emailResourceId(intent?: SideEffectIntent) {
	const value = intent?.metadata.emailResourceId
	return typeof value === 'string' && value.length > 0 ? value : undefined
}

function isTerminalEmailResourceId(value?: string) {
	return value?.endsWith('.email-6') || value?.endsWith('.team-email-6')
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

function nextEmailResourceId(value?: string) {
	if (!value) return undefined
	const match = value.match(/(?:team-)?email-(\d+)$/)
	if (!match) return undefined
	const step = Number(match[1])
	if (!Number.isInteger(step) || step >= 6) return undefined
	return value.replace(/(?:team-)?email-\d+$/, (segment) =>
		segment.startsWith('team-email-')
			? `team-email-${step + 1}`
			: `email-${step + 1}`,
	)
}

function emailStepNumber(intent: SideEffectIntent) {
	const match = emailResourceId(intent)?.match(/(?:team-)?email-(\d+)$/)
	return match ? Number(match[1]) : -1
}

function latestActivityAt(intents: SideEffectIntent[]) {
	const timestamps = intents.map(activityAt).filter(Boolean).sort()
	return timestamps[timestamps.length - 1]
}

function activityAt(intent: SideEffectIntent) {
	return valuePathIntentCompletedAt(intent) ??
		(validDate(intent.createdAt) ? intent.createdAt : '')
}

function hasSignal(intent: SideEffectIntent, signal: string) {
	if (intent.reviewReasons.includes(signal)) return true
	if (intent.metadata[signal] === true) return true
	const providerResult = intent.metadata.providerResult
	return Boolean(
		providerResult &&
			typeof providerResult === 'object' &&
			(providerResult as Record<string, unknown>)[signal] === true,
	)
}

function isScheduledRetry(intent: SideEffectIntent, now: string) {
	const nextRetryAt = intent.metadata.nextRetryAt
	return (
		typeof nextRetryAt === 'string' &&
		validDate(nextRetryAt) &&
		new Date(nextRetryAt) > new Date(now)
	)
}

function hasRecentCourseProgress(intents: SideEffectIntent[], now: string) {
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

function exceedsMovementTolerance(intent: SideEffectIntent, now: string) {
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
